import assert from "node:assert";
import {
  renderInkMap,
  renderInkTexture,
  releaseInkMap,
  MAP_OVERSAMPLE as OS,
} from "../src/ink-map.mjs";

const b64 = (binary) => Buffer.from(binary, "binary").toString("base64");

// Decodes the 24bpp BMP the module produces back into pixels, so the tests can
// assert on what a browser would actually see.
function decodeBmp(dataUrl) {
  const m = /^data:image\/bmp;base64,(.+)$/.exec(dataUrl);
  assert.ok(m, "expected a bmp data url");
  const buf = Buffer.from(m[1], "base64");
  assert.strictEqual(buf.toString("latin1", 0, 2), "BM");
  assert.strictEqual(buf.readUInt32LE(2), buf.length, "size field must match");
  const offset = buf.readUInt32LE(10);
  const w = buf.readInt32LE(18);
  const h = buf.readInt32LE(22);
  assert.strictEqual(buf.readUInt16LE(28), 24, "24 bits per pixel");
  assert.ok(h < 0, "rows must be top-down");
  const rows = -h;
  const stride = (w * 3 + 3) & ~3;
  const at = (x, y) => {
    const o = offset + y * stride + x * 3;
    return [buf[o + 2], buf[o + 1], buf[o]]; // stored BGR
  };
  return { w, h: rows, at, stride, buf, offset };
}

// A field with a known, non-symmetric layout: red top-left, green top-right,
// blue bottom-left, white bottom-right. Any transposition, row flip or channel
// swap shows up immediately.
function quadField(w, h) {
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const top = y < h / 2;
      const left = x < w / 2;
      const c = top && left ? [255, 0, 0] : top ? [0, 255, 0] : left ? [0, 0, 255] : [255, 255, 255];
      const o = (y * w + x) * 4;
      pixels[o] = c[0];
      pixels[o + 1] = c[1];
      pixels[o + 2] = c[2];
      pixels[o + 3] = 255;
    }
  }
  return { w, h, pixels };
}

// --- geometry: orientation and channel order survive the encode ------------
{
  const field = quadField(8, 8);
  const bmp = decodeBmp(renderInkMap(field, null, b64));
  assert.strictEqual(bmp.w, 8 * OS);
  assert.strictEqual(bmp.h, 8 * OS);
  const last = 8 * OS - 1;
  assert.deepStrictEqual(bmp.at(0, 0), [255, 0, 0], "top-left stays red");
  assert.deepStrictEqual(bmp.at(last, 0), [0, 255, 0], "top-right stays green");
  assert.deepStrictEqual(bmp.at(0, last), [0, 0, 255], "bottom-left stays blue");
  assert.deepStrictEqual(bmp.at(last, last), [255, 255, 255], "bottom-right stays white");
}

// --- the crop is what lines the map up with the glyphs ---------------------
{
  const field = quadField(8, 8);
  // Bottom-right quadrant only: every pixel must be white.
  const bmp = decodeBmp(renderInkMap(field, { x0: 4, y0: 4, x1: 8, y1: 8 }, b64));
  assert.strictEqual(bmp.w, 4 * OS);
  assert.strictEqual(bmp.h, 4 * OS);
  // Everything but the outermost pixels, which legitimately reconstruct from
  // the tile centres either side of the crop edge — that is what makes a
  // fractional crop line up at all.
  for (let y = 1; y < 4 * OS; y++) {
    for (let x = 1; x < 4 * OS; x++) {
      assert.deepStrictEqual(bmp.at(x, y), [255, 255, 255], `crop leaked at ${x},${y}`);
    }
  }
  // Top-left quadrant: all red.
  const tl = decodeBmp(renderInkMap(field, { x0: 0, y0: 0, x1: 4, y1: 4 }, b64));
  assert.deepStrictEqual(tl.at(0, 0), [255, 0, 0]);
  assert.deepStrictEqual(tl.at(4 * OS - 2, 4 * OS - 2), [255, 0, 0]);
}

// --- a fractional crop resamples rather than snapping ----------------------
// A window edge lands wherever it lands on a 30-pixel grid, so this is the
// normal case, not the exotic one.
{
  const w = 8;
  const pixels = new Uint8ClampedArray(w * 4);
  for (let x = 0; x < w; x++) {
    const v = x * 32;
    pixels[x * 4] = v;
    pixels[x * 4 + 1] = v;
    pixels[x * 4 + 2] = v;
    pixels[x * 4 + 3] = 255;
  }
  const field = { w, h: 1, pixels };
  const bmp = decodeBmp(renderInkMap(field, { x0: 2.5, y0: 0, x1: 6.5, y1: 1 }, b64));
  assert.strictEqual(bmp.w, 4 * OS);
  const values = Array.from({ length: bmp.w }, (_, x) => bmp.at(x, 0)[0]);
  // Monotonic across the crop, and strictly inside the values at its edges.
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i] > values[i - 1], `not monotonic: ${values}`);
  }
  assert.ok(values[0] >= 2 * 32 && values[3] <= 6 * 32, `crop out of range: ${values}`);
}

// --- row padding is zeroed, so a reused buffer cannot leak the last frame --
{
  // An odd output width is what leaves padding bytes: 3 tiles at this
  // oversample is 3*OS pixels, and 3 bytes each rounds up to a 4-byte stride.
  const field = quadField(6, 6);
  renderInkMap(field, null, b64); // fills the scratch buffer
  const bmp = decodeBmp(renderInkMap(field, { x0: 0, y0: 0, x1: 2.5, y1: 3 }, b64));
  const used = bmp.w * 3;
  assert.ok(bmp.stride > used, `expected padding, stride ${bmp.stride} vs ${used}`);
  for (let y = 0; y < bmp.h; y++) {
    for (let p = used; p < bmp.stride; p++) {
      assert.strictEqual(bmp.buf[bmp.offset + y * bmp.stride + p], 0, "padding not zeroed");
    }
  }
}

// --- a light/dark boundary is a step, never a ramp through mid-grey -------
// This is the measured failure: interpolating between a light-ink tile and a
// dark-ink tile produces mid-grey, and mid-grey is exactly what cannot be read
// on the mid-grey background that caused the flip in the first place.
{
  const w = 4;
  const pixels = new Uint8ClampedArray(w * 4);
  const sides = new Uint8Array(w);
  for (let x = 0; x < w; x++) {
    const dark = x >= 2;
    const v = dark ? 20 : 235;
    sides[x] = dark ? 1 : 0;
    pixels[x * 4] = v;
    pixels[x * 4 + 1] = v;
    pixels[x * 4 + 2] = v;
    pixels[x * 4 + 3] = 255;
  }
  const field = { w, h: 1, pixels, sides };
  const bmp = decodeBmp(renderInkMap(field, null, b64));
  for (let x = 0; x < bmp.w; x++) {
    const v = bmp.at(x, 0)[0];
    assert.ok(
      v <= 40 || v >= 215,
      `pixel ${x} landed in the unreadable middle at ${v}`,
    );
  }
  // Without the side information there is nothing to snap to, and the ramp is
  // back — which is what makes passing `sides` load-bearing rather than a
  // refinement.
  const blurred = decodeBmp(renderInkMap({ w, h: 1, pixels }, null, b64));
  const mids = [];
  for (let x = 0; x < blurred.w; x++) {
    const v = blurred.at(x, 0)[0];
    if (v > 40 && v < 215) mids.push(v);
  }
  assert.ok(mids.length > 0, "without sides, the boundary should still ramp");
}

// --- within one side the gradient stays smooth ---------------------------
{
  const w = 4;
  const pixels = new Uint8ClampedArray(w * 4);
  const sides = new Uint8Array(w); // all light
  for (let x = 0; x < w; x++) {
    const v = 150 + x * 25;
    pixels[x * 4] = v;
    pixels[x * 4 + 1] = v;
    pixels[x * 4 + 2] = v;
    pixels[x * 4 + 3] = 255;
  }
  const bmp = decodeBmp(renderInkMap({ w, h: 1, pixels, sides }, null, b64));
  const values = [];
  for (let x = 0; x < bmp.w; x++) values.push(bmp.at(x, 0)[0]);
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i] >= values[i - 1], `not monotonic within a side: ${values}`);
  }
  assert.ok(
    new Set(values).size > w,
    "oversampling should give more distinct steps than tiles",
  );
}

// --- degenerate input is refused, not half-drawn --------------------------
{
  const field = quadField(4, 4);
  assert.strictEqual(renderInkMap(null, null, b64), null);
  assert.strictEqual(renderInkMap({ w: 0, h: 0, pixels: new Uint8ClampedArray() }, null, b64), null);
  assert.strictEqual(renderInkMap(field, { x0: 2, y0: 2, x1: 2, y1: 4 }, b64), null, "empty crop");
  assert.strictEqual(renderInkMap(field, { x0: 9, y0: 9, x1: 12, y1: 12 }, b64), null, "crop off the field");
  // The injected encoder is what the tests run on; without one the module
  // falls back to the platform's btoa (present in both a WebView and node).
  let seen = null;
  renderInkMap(field, null, (binary) => {
    seen = binary;
    return "STUB";
  });
  assert.ok(seen && seen.startsWith("BM"), "the encoder receives the raw bmp bytes");
  releaseInkMap();
  assert.ok(renderInkMap(field, null, b64), "still works after release");
}

// --- the texture is the same map, in the container a GPU wants -------------
// The two encoders must never drift apart: the CSS path and the WebGL path put
// the same colour on the same letter, and the only difference is the wrapper.
// Comparing them pixel-for-pixel is what keeps that true, and it is also the
// orientation test — the BMP is asserted top-down above, so agreeing with it
// means the texture rows are top-down too (data offset 0 sits at t=0 in GL,
// which is why neither side flips anything).
{
  const field = quadField(8, 8);
  const crops = [null, { x0: 4, y0: 4, x1: 8, y1: 8 }, { x0: 1.5, y0: 0.25, x1: 6.5, y1: 5.75 }];
  for (const crop of crops) {
    const bmp = decodeBmp(renderInkMap(field, crop, b64));
    const tex = renderInkTexture(field, crop);
    assert.strictEqual(tex.w, bmp.w, "same width as the image path");
    assert.strictEqual(tex.h, bmp.h, "same height as the image path");
    assert.strictEqual(tex.data.length, tex.w * tex.h * 3, "tightly packed, no stride padding");
    for (let y = 0; y < tex.h; y++) {
      for (let x = 0; x < tex.w; x++) {
        const o = (y * tex.w + x) * 3;
        assert.deepStrictEqual(
          [tex.data[o], tex.data[o + 1], tex.data[o + 2]],
          bmp.at(x, y),
          `texture and image disagree at ${x},${y}`,
        );
      }
    }
  }
}

// --- channel order is RGB, not the BMP's BGR ------------------------------
// Cheap to get wrong (the two encoders sit next to each other and one of them
// writes backwards on purpose) and it would show up as a blue shell.
{
  const pixels = new Uint8ClampedArray([200, 100, 50, 255]);
  const tex = renderInkTexture({ w: 1, h: 1, pixels }, null);
  assert.deepStrictEqual([tex.data[0], tex.data[1], tex.data[2]], [200, 100, 50]);
}

// --- the light/dark step survives into the texture too --------------------
{
  const w = 4;
  const pixels = new Uint8ClampedArray(w * 4);
  const sides = new Uint8Array(w);
  for (let x = 0; x < w; x++) {
    const dark = x >= 2;
    const v = dark ? 20 : 235;
    sides[x] = dark ? 1 : 0;
    pixels[x * 4] = v;
    pixels[x * 4 + 1] = v;
    pixels[x * 4 + 2] = v;
    pixels[x * 4 + 3] = 255;
  }
  const tex = renderInkTexture({ w, h: 1, pixels, sides }, null);
  for (let x = 0; x < tex.w; x++) {
    const v = tex.data[x * 3];
    assert.ok(v <= 40 || v >= 215, `pixel ${x} landed in the unreadable middle at ${v}`);
  }
}

// --- degenerate input is refused the same way -----------------------------
{
  const field = quadField(4, 4);
  assert.strictEqual(renderInkTexture(null, null), null);
  assert.strictEqual(renderInkTexture({ w: 0, h: 0, pixels: new Uint8ClampedArray() }, null), null);
  assert.strictEqual(renderInkTexture(field, { x0: 2, y0: 2, x1: 2, y1: 4 }, null), null, "empty crop");
  assert.strictEqual(renderInkTexture(field, { x0: 9, y0: 9, x1: 12, y1: 12 }), null, "crop off the field");
  releaseInkMap();
  assert.ok(renderInkTexture(field, null), "still works after release");
}

// --- the scratch buffer is resized, not reused at the wrong length --------
// A smaller crop after a bigger one must not leave the previous frame's tail
// hanging off the end of the array the caller uploads.
{
  const field = quadField(8, 8);
  const big = renderInkTexture(field, null);
  assert.strictEqual(big.data.length, big.w * big.h * 3);
  const small = renderInkTexture(field, { x0: 0, y0: 0, x1: 2, y1: 2 });
  assert.strictEqual(small.data.length, small.w * small.h * 3);
  assert.ok(small.data.length < big.data.length);
}

console.log("ink-map tests passed");
