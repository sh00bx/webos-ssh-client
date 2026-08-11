// Turns an ink field (ink-field.mjs) into an image the compositor can apply to
// the text for us.
//
// The alternative was colouring cells individually, and it is worth writing
// down why that lost. xterm's DOM renderer merges every run of same-styled
// cells into one <span>; a per-cell colour breaks every one of those runs
// apart, so a full-width line of shell output goes from one element to two
// hundred, on every frame of the feed, for forty rows. Handing the colours to
// CSS as a background image clipped to the glyphs instead costs one property
// update per frame no matter how much text is on screen — and it resolves per
// *pixel*, so a letter straddling the edge of a bright object gets a gradient
// across itself rather than one flat compromise colour.
//
// The image is a hand-built uncompressed BMP rather than a canvas PNG, and
// that is not premature cleverness — it is the single biggest thing measured on
// this TV. Encoding this image (127×68) with canvas.toDataURL:
//
//     image/png    105 ms          <- what the first version shipped
//     image/webp     9 ms
//     image/jpeg     6 ms
//     BMP, by hand   2 ms
//
// 105 ms of main thread at the feed's cadence is what made the shell feel
// laggy to type in. JPEG and WebP are fast enough but both are lossy, and this
// image is not a picture — it is a lookup table of solved colours, where a
// ringing artefact is a wrong colour on a letter. The BMP is exact, and the
// encoder is a header plus the bytes: there is nothing to compress and nothing
// to go wrong. Verified on device that Chrome 120 decodes data:image/bmp back
// pixel-for-pixel. (document.getCSSCanvasContext, which would have skipped the
// encode entirely, no longer exists in this Chromium.)
//
// Cropping happens here too, which is what keeps the map lined up for free: the
// image the stylesheet gets *is* the glyph-rows box, so it is applied with a
// plain `background-size: 100% 100%` and stays correct through drags, resizes,
// fullscreen and font changes without a single geometry hook. The alternative —
// one screen-sized image offset back to the viewport origin — needs that offset
// rewritten on every one of those events, and is wrong for the whole duration
// of a drag.

const BMP_HEADER_BYTES = 54;
export const MAP_OVERSAMPLE = 2;

let bmpScratch = null;
let texScratch = null;

function scratchBytes(size) {
  if (!bmpScratch || bmpScratch.length !== size) bmpScratch = new Uint8Array(size);
  return bmpScratch;
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

// Reads the field at a fractional pixel position, edge-clamped. Bilinear —
// except across a light/dark boundary, where it snaps to the nearest tile.
//
// That exception is the difference between readable and not, and it was
// measured: with a plain bilinear blend, a menu button showing through the
// panel landed between a light-ink tile and a dark-ink tile, and the colours in
// between are mid-grey — on a mid-grey background, at 1.22:1. The background
// there wanted light ink at 5.97:1; nothing was wrong with the decision, only
// with the ramp between two correct answers. Interpolating *within* one side is
// harmless and keeps the gradient smooth, so only the crossing is snapped.
//
// This is also why the caller oversamples and the stylesheet asks for
// `image-rendering: pixelated`: a sharp edge here would just be blurred back
// into a ramp by the compositor's own upscale.
function sampleField(field, fx, fy, out) {
  const x = clamp(fx, 0, field.w - 1);
  const y = clamp(fy, 0, field.h - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1 < field.w ? x0 + 1 : x0;
  const y1 = y0 + 1 < field.h ? y0 + 1 : y0;
  const tx = x - x0;
  const ty = y - y0;
  const p = field.pixels;
  const i00 = (y0 * field.w + x0) * 4;
  const i10 = (y0 * field.w + x1) * 4;
  const i01 = (y1 * field.w + x0) * 4;
  const i11 = (y1 * field.w + x1) * 4;

  const sides = field.sides;
  if (sides) {
    const s00 = sides[y0 * field.w + x0];
    if (
      s00 !== sides[y0 * field.w + x1] ||
      s00 !== sides[y1 * field.w + x0] ||
      s00 !== sides[y1 * field.w + x1]
    ) {
      const near = ((ty < 0.5 ? y0 : y1) * field.w + (tx < 0.5 ? x0 : x1)) * 4;
      out[0] = p[near];
      out[1] = p[near + 1];
      out[2] = p[near + 2];
      return;
    }
  }

  for (let c = 0; c < 3; c++) {
    const top = p[i00 + c] + (p[i10 + c] - p[i00 + c]) * tx;
    const bottom = p[i01 + c] + (p[i11 + c] - p[i01 + c]) * tx;
    out[c] = top + (bottom - top) * ty;
  }
}

// btoa needs a binary string; building it in chunks avoids blowing the
// argument limit on apply() for a map of any size.
function toBase64(bytes, encode) {
  const chunk = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return encode(binary);
}

// The crop in field coordinates plus the output resolution both encoders use.
// Two output pixels per source tile: the mapping onto the box is exact at any
// resolution (the consumer stretches whatever it gets across the whole box), so
// this is not about accuracy — it is about how coarse the steps are once the
// smoothing stops. At one pixel per tile the blocks are ~30 screen pixels,
// three character cells, which reads as banding. Halving that costs four times
// the bytes on something that is still only tens of kilobytes, and no extra
// solving at all.
function cropGeometry(field, crop) {
  if (!field || !field.w || !field.h) return null;
  const x0 = crop ? clamp(crop.x0, 0, field.w) : 0;
  const y0 = crop ? clamp(crop.y0, 0, field.h) : 0;
  const cw = (crop ? clamp(crop.x1, 0, field.w) : field.w) - x0;
  const ch = (crop ? clamp(crop.y1, 0, field.h) : field.h) - y0;
  if (!(cw > 0 && ch > 0)) return null;
  return {
    x0,
    y0,
    cw,
    ch,
    outW: Math.max(1, Math.ceil(cw * MAP_OVERSAMPLE)),
    outH: Math.max(1, Math.ceil(ch * MAP_OVERSAMPLE)),
  };
}

/**
 * The same map as renderInkMap, as raw top-down RGB bytes for a GL texture
 * rather than as an image the compositor has to decode and rasterise.
 *
 * This is the whole point of the WebGL path: on the CSS path the map has to
 * become a *picture* (encode, base64, data URL, decode, then a full re-raster
 * of the text-clipped layer — measured at 100+ ms of GPU on this Mali). As a
 * texture it is a few kilobytes handed straight to the GPU, and the colour a
 * glyph takes is a lookup in the fragment shader.
 *
 * Sampling is shared with the BMP encoder down to the edge-snap, so both paths
 * put the same colour on the same letter; only the container differs. Rows are
 * generated top-down and uploaded in that order, which is what a GL texture
 * wants (data offset 0 sits at t=0) — no flip anywhere.
 *
 * The returned array is a reused scratch buffer, valid until the next call.
 * The caller uploads it synchronously; nothing may hold on to it.
 *
 * @returns {{w:number,h:number,data:Uint8Array}|null}
 */
export function renderInkTexture(field, crop) {
  const geo = cropGeometry(field, crop);
  if (!geo) return null;
  const { x0, y0, cw, ch, outW, outH } = geo;

  const size = outW * outH * 3;
  if (!texScratch || texScratch.length !== size) texScratch = new Uint8Array(size);
  const bytes = texScratch;

  const rgb = [0, 0, 0];
  let o = 0;
  for (let j = 0; j < outH; j++) {
    const sy = y0 + ((j + 0.5) * ch) / outH - 0.5;
    for (let i = 0; i < outW; i++) {
      sampleField(field, x0 + ((i + 0.5) * cw) / outW - 0.5, sy, rgb);
      bytes[o++] = rgb[0] | 0;
      bytes[o++] = rgb[1] | 0;
      bytes[o++] = rgb[2] | 0;
    }
  }
  return { w: outW, h: outH, data: bytes };
}

/**
 * @param crop {x0,y0,x1,y1} in field coordinates; fractional, and it must be,
 *             since a window edge lands wherever it lands on a coarse grid.
 * @returns a data URL, or null if there is nothing to draw — in which case the
 *          caller keeps the single flat ink colour and nothing breaks.
 */
export function renderInkMap(field, crop, encoder) {
  const encode = encoder || (typeof btoa === "function" ? btoa : null);
  if (!encode) return null;
  const geo = cropGeometry(field, crop);
  if (!geo) return null;
  const { x0, y0, cw, ch, outW, outH } = geo;

  const rowStride = (outW * 3 + 3) & ~3;
  const pixelBytes = rowStride * outH;
  const bytes = scratchBytes(BMP_HEADER_BYTES + pixelBytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset);

  bytes[0] = 0x42; // 'B'
  bytes[1] = 0x4d; // 'M'
  view.setUint32(2, bytes.length, true);
  view.setUint32(10, BMP_HEADER_BYTES, true);
  view.setUint32(14, 40, true); // BITMAPINFOHEADER
  view.setInt32(18, outW, true);
  // Negative height = rows stored top-down, which is the order they are
  // generated in. A positive height here would flip the map vertically and
  // colour the top of the shell from the bottom of the screen.
  view.setInt32(22, -outH, true);
  view.setUint16(26, 1, true); // planes
  view.setUint16(28, 24, true); // bits per pixel
  view.setUint32(34, pixelBytes, true);

  const rgb = [0, 0, 0];
  for (let j = 0; j < outH; j++) {
    const sy = y0 + ((j + 0.5) * ch) / outH - 0.5;
    let o = BMP_HEADER_BYTES + j * rowStride;
    for (let i = 0; i < outW; i++) {
      sampleField(field, x0 + ((i + 0.5) * cw) / outW - 0.5, sy, rgb);
      bytes[o++] = rgb[2] | 0; // BMP is BGR
      bytes[o++] = rgb[1] | 0;
      bytes[o++] = rgb[0] | 0;
    }
    // The stride padding is whatever the previous frame left there; zero it so
    // the bytes are deterministic.
    while (o < BMP_HEADER_BYTES + (j + 1) * rowStride) bytes[o++] = 0;
  }

  return `data:image/bmp;base64,${toBase64(bytes, encode)}`;
}


// The veil that used to be encoded here as a second image (a hand-built PNG
// with stored deflate blocks — see git history) is now a single alpha for the
// whole window, applied by the caller as a plain background-color: the
// per-tile version was measurably right and visually wrong (clouding), and
// its full-screen image layer was a raster cost the renderer paid on every
// frame of the feed.

// Dropped on teardown so a closed session does not keep the scratch buffers
// alive for the lifetime of the page.
export function releaseInkMap() {
  bmpScratch = null;
  texScratch = null;
}
