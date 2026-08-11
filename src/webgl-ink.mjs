// Chameleon per-glyph ink on a WebGL renderer.
//
// WHY THIS EXISTS
//
// The CSS mechanism this replaces paints the solved ink field as one background
// image on the glyph-rows box and clips it to the text (`background-clip: text`,
// see styles.css). It is correct and it resolves per pixel, but on this TV's
// Mali-G510 one map update costs 100+ ms of GPU raster: changing the background
// image invalidates the whole text-clipped layer, thousands of glyph masks, and
// there is no partial-invalidation path. Measured by A/B on the device: with
// clip:text switched off the page presented at 67 ms p50, with it on and the map
// updating a few times a second, 217 ms. Every pacing knob in theme-controller
// (the adaptive solve floor, the typing deferral, the drift deadband) exists to
// ration that one raster.
//
// A GPU has no such problem with per-glyph colour: the glyphs are already in a
// texture atlas, so colouring them is a lookup. That is what this module does.
//
// HOW
//
// xterm's WebGL renderer bakes the foreground colour INTO the atlas: glyphs are
// cached on (code, bg, fg, ext), so a per-cell colour that moves every frame
// would miss the cache on every cell of every frame and re-rasterise the screen
// through fillText/getImageData. (The same objection rules out driving it
// through xterm's decoration service, which feeds the same colour-keyed atlas.)
//
// So the colour does not go through the atlas at all:
//
//   1. Cells eligible for ink are rasterised WHITE — updateCell is patched to
//      rewrite `fg` before the atlas ever sees it. One atlas entry per glyph
//      shape, whatever the picture behind the window is doing.
//   2. Straight after xterm's glyph draw, one full-canvas quad is drawn with
//      dst.rgb *= src.rgb, sampling the ink field as a texture, discarded
//      wherever a cell-resolution mask says the cell is not eligible.
//
// That is exact, not an approximation. With allowTransparency the atlas draws
// glyphs over a transparent background, so a texel is (fg.rgb, coverage)
// un-premultiplied, and with the corrected base blend (see applyBaseBlend) a
// glyph of coverage a lands on a transparent destination as:
//
//      white glyph  ->  dst.rgb = a       dst.a = a
//      x ink        ->  dst.rgb = ink·a   dst.a = a    (alpha factors ZERO/ONE)
//      ink directly ->  dst.rgb = ink·a   dst.a = a
//
// — identical, antialiasing ramp included. And multiplying a transparent pixel
// by anything leaves it transparent, which is what confines the pass to the
// glyphs without any masking of its own.
//
// The module owns every piece of knowledge about xterm's renderer internals so
// the rest of the app can stay in terms of "hand me an ink field".

import { WebglAddon } from "xterm-addon-webgl";
import { hexToRgb, oklabDistance } from "./color.mjs";

// Mirrored from xterm's common/buffer/Constants.ts. Restated rather than
// imported: they are `const enum`s inside the bundle with no public export, and
// the values are part of the wire format of a cell attribute, not an
// implementation detail that can drift under a patch release.
const CM_MASK = 0x3000000; // colour-mode bits (DEFAULT | P16 | P256 | RGB)
const CM_DEFAULT = 0;
const CM_RGB = 0x3000000;
const FG_INVERSE = 0x4000000;
// BgFlags.HAS_EXTENDED marks a cell carrying extended attributes — an
// underline STYLE (curly, dotted, dashed) and/or an explicit underline COLOUR
// (SGR 58). Only the colour matters here: the atlas strokes the underline with
// `strokeStyle = fillStyle` unless a colour is actually set
// (TextureAtlas.ts:528-540, AttributeData.isUnderlineColorDefault), so a curly
// underline with no colour of its own is whitened along with the glyph and
// tints correctly. An explicit colour is stroked in that colour and the
// multiply would turn it into something else, so those cells alone stay on the
// theme foreground. The colour mode sits in the ext word.
const BG_HAS_EXTENDED = 0x10000000;
// Colour value plus colour mode. Everything above this — inverse, bold,
// underline, blink, invisible, strikethrough — has to survive the rewrite, or
// bold text would stop being bold the moment the ink took over.
const FG_COLOR_AND_MODE = 0x3ffffff;
const WHITE_FG = CM_RGB | 0xffffff;

// How far (OKLab) the flat ink must move before the cells carrying it are
// re-rasterised. Deliberately coarser than the theme controller's own repaint
// deadband: adopting a new flat ink re-rasterises one atlas entry per distinct
// (glyph, cell-background) pair on screen, measured at ~1.5 ms each on this
// TV — a band-heavy screen holds a few hundred of those, so an adoption is a
// one-frame cost of up to a few hundred ms. At 0.12 that happens on a real
// scene regime change (a side flip, day to night), not on drift; and the ink
// it defers only reaches glyphs standing on filled cells, whose readability is
// set by the fill they stand on, not by the scene the deferral tracks.
const FLAT_INK_ADOPT_DISTANCE = 0.12;

// RectangleRenderer's vertex layout: 8 floats per rectangle, alpha last.
// Rectangle 0 is the full-viewport background quad, written by
// _updateViewportRectangle; the cell backgrounds start at 1 and each one is
// written at its own offset, which is what the alpha index is relative to.
const RECT_ALPHA_INDEX = 7;

// xterm's own 0-1 -> clip-space matrix (y flipped, so y=0 is the top). Restated
// for the same reason as the attribute bits, and load-bearing for the texture
// orientation: both textures are uploaded top row first, GL puts data offset 0
// at t=0, and this puts y=0 at the top of the viewport — so the same
// coordinate addresses both, and nothing anywhere flips.
const PROJECTION_MATRIX = new Float32Array([
  2, 0, 0, 0,
  0, -2, 0, 0,
  0, 0, 1, 0,
  -1, 1, 0, 1,
]);

const VERTEX_SRC = `#version 300 es
layout (location = 0) in vec2 a_unitquad;
uniform mat4 u_projection;
out vec2 v_uv;
void main() {
  v_uv = a_unitquad;
  gl_Position = u_projection * vec4(a_unitquad, 0.0, 1.0);
}`;

// highp on purpose: at mediump's guaranteed precision a coordinate across a
// 1120 px canvas can land a pixel out, which on a cell-resolution mask is a
// whole cell's worth of wrong answer.
const FRAGMENT_SRC = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_ink;
uniform sampler2D u_mask;
out vec4 outColor;
void main() {
  if (texture(u_mask, v_uv).r < 0.5) discard;
  outColor = vec4(texture(u_ink, v_uv).rgb, 1.0);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`ink shader: ${log}`);
  }
  return shader;
}

function link(gl, vertexSource, fragmentSource) {
  const program = gl.createProgram();
  const vs = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  // The shaders are reachable through the program until it is deleted; flagging
  // them here is what lets the driver reclaim them with it.
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error(`ink program: ${log}`);
  }
  return program;
}

/**
 * @param term           the xterm Terminal (already open)
 * @param onDebugEvent   optional (name, payload) logger
 * @param onDomRestored  called whenever a teardown has put a FRESH DOM renderer
 *                       back in place. Every exit from here goes through it —
 *                       the deliberate switch, a failed activation, and a lost
 *                       context three seconds later — because the new renderer
 *                       needs the same fixing-up after all three, and a caller
 *                       that only handles the deliberate one leaves the other
 *                       two painting 24-bit cell backgrounds unpatched.
 */
export function createWebglInk({ term, onDebugEvent, onDomRestored } = {}) {
  const debug = typeof onDebugEvent === "function" ? onDebugEvent : () => {};

  let addon = null;
  let renderer = null;
  let gl = null;

  // GL objects, all tied to the current context — dropped and rebuilt if it is
  // ever lost and restored.
  let program = null;
  let vao = null;
  let quadBuffer = null;
  let indexBuffer = null;
  let inkTexture = null;
  let maskTexture = null;
  let projectionLocation = null;
  let inkUnit = 0;
  let maskUnit = 1;
  let restoreAtlasUnits = false;

  // The patched objects, remembered so the patches can be recognised as already
  // applied and can be undone.
  let patchedGlyph = null;
  let patchedRect = null;
  let patchedRenderer = null;

  // Cell-resolution eligibility, written one byte at a time by the patched
  // updateCell (never swept per frame) and uploaded when it has moved.
  let mask = null;
  let maskCols = 0;
  let maskRows = 0;
  let maskDirty = true;

  let inkW = 0;
  let inkH = 0;
  let inkReady = false;
  // Whether cells should be rasterised white at all. Off means the renderer
  // behaves exactly like stock xterm.
  let inkOn = false;
  // 🔑 The theme foreground the glyph atlas is PINNED to while this renderer is
  // live, and the flat ink carried around it. xterm's atlas cache is keyed on
  // the theme (CharAtlasUtils.configEquals compares colors.foreground.rgba),
  // so every setTheme that moved the flat ink DISPOSED the whole atlas and
  // re-rasterised every glyph on screen through fillText + getImageData —
  // measured on this TV at ~1.5 ms per glyph, ~450 ms per screenful, firing
  // about every 1.5 s under a drifting picture. So the foreground handed to
  // xterm never moves (pinTheme), the config stays equal, the atlas survives —
  // and the flat ink reaches the glyphs that actually need it (default-fg text
  // on filled cells) as an explicit RGB rewritten in updateCell, exactly the
  // way the white rewrite already works for the ink-textured cells. Cursor,
  // selection and cursorAccent keep flowing through setTheme untouched: none
  // of them participate in configEquals, so they were never the cost.
  let pinnedFg = null;
  let flatInkWord = 0;
  let flatInkHex = null;
  // The one place the flat ink is written, so the hex and the packed word can
  // never disagree — three callers set it (enable, pinTheme's deadband,
  // adoptFlatInk) and an unparseable colour must leave BOTH untouched.
  function writeFlatInk(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return;
    flatInkHex = hex;
    flatInkWord = CM_RGB | (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
  }
  let cellAlpha = 1;
  let tintFailed = false;
  // GL objects are built and usable. Cleared whenever they are released, so the
  // per-frame guard never has to ask the driver.
  let glReady = false;
  // A device whose WebGL2 activation threw is not going to start working on the
  // next overlay show. Without this latch every hide/show cycle would build a
  // fresh canvas and context to fail again, and leak them.
  let activationFailed = false;
  let restoreListener = null;
  let lostListener = null;

  // Cheap enough for the per-frame path: gl.isProgram is a synchronous query
  // into the GPU process, and the tint pass runs on every rendered frame.
  // ensure() still does the authoritative isProgram probe at ink cadence.
  function alive() {
    return Boolean(glReady && gl && !gl.isContextLost());
  }

  function currentRenderer() {
    try {
      const service = term && term._core && term._core._renderService;
      const value = service && service._renderer && service._renderer.value;
      return value && value._gl ? value : null;
    } catch (e) {
      return null;
    }
  }

  function releaseGl() {
    if (gl && !gl.isContextLost()) {
      if (program) gl.deleteProgram(program);
      if (vao) gl.deleteVertexArray(vao);
      if (quadBuffer) gl.deleteBuffer(quadBuffer);
      if (indexBuffer) gl.deleteBuffer(indexBuffer);
      if (inkTexture) gl.deleteTexture(inkTexture);
      if (maskTexture) gl.deleteTexture(maskTexture);
    }
    forgetGl();
  }

  // Drop the handles without touching the driver. Used when the context has
  // gone away underneath them: after a restore `isContextLost()` reads false
  // again, so a release that late would hand the new context objects belonging
  // to the dead one.
  function forgetGl() {
    program = null;
    vao = null;
    quadBuffer = null;
    indexBuffer = null;
    inkTexture = null;
    maskTexture = null;
    glReady = false;
    inkReady = false;
    inkW = 0;
    inkH = 0;
    maskDirty = true;
    // Load-bearing, not tidiness: while the ink is on, updateCell rasterises
    // eligible glyphs WHITE and relies on the tint pass to colour them. With
    // the GL objects gone there is no tint pass, so leaving this on would paint
    // a screenful of white text. Off means the glyphs go back through the atlas
    // in their real colours; the next solve turns the effect on again.
    inkOn = false;
  }

  function initGl() {
    releaseGl();
    program = link(gl, VERTEX_SRC, FRAGMENT_SRC);
    projectionLocation = gl.getUniformLocation(program, "u_projection");

    // xterm claims one texture unit per potential atlas page, and it computes
    // that count exactly like this (TextureAtlas.maxAtlasPages). Sitting above
    // it means our two textures can never evict an atlas page — on this TV the
    // limit is 64, so units 32 and 33 are simply free. Where the limit is tight
    // enough that they are not, fall back to the bottom two units and put the
    // atlas bindings back after every draw.
    //
    // Two limits, not one: xterm sizes its page count from the FRAGMENT unit
    // count, but activeTexture is bounded by the COMBINED count, and only the
    // smaller of the two is a unit we may legally select.
    const fragmentUnits = gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS) || 8;
    const combinedUnits = gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS) || fragmentUnits;
    const maxUnits = Math.min(fragmentUnits, combinedUnits);
    const atlasUnits = Math.min(32, fragmentUnits);
    if (atlasUnits + 2 <= maxUnits) {
      inkUnit = atlasUnits;
      maskUnit = atlasUnits + 1;
      restoreAtlasUnits = false;
    } else {
      inkUnit = 0;
      maskUnit = 1;
      restoreAtlasUnits = true;
    }

    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "u_ink"), inkUnit);
    gl.uniform1i(gl.getUniformLocation(program, "u_mask"), maskUnit);
    gl.uniformMatrix4fv(projectionLocation, false, PROJECTION_MATRIX);

    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint8Array([0, 1, 2, 3]), gl.STATIC_DRAW);
    gl.bindVertexArray(null);

    inkTexture = makeTexture(inkUnit);
    maskTexture = makeTexture(maskUnit);
    // Creating them left our textures bound where the atlas pages belong, on
    // the fallback path where we had to borrow the bottom units.
    if (restoreAtlasUnits) restoreAtlasBindings();

    // Both of our uploads are tightly packed byte rows (RGB and R8), and the
    // default unpack alignment of 4 would shear every row whose width is not a
    // multiple of 4. Safe to leave set: xterm uploads its atlas from a canvas
    // element, and element uploads ignore this entirely.
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    applyBaseBlend();
    glReady = true;
  }

  // Straight (non-premultiplied) source into a PREMULTIPLIED destination.
  //
  // The addon sets blendFunc(SRC_ALPHA, ONE_MINUS_SRC_ALPHA) once in the glyph
  // renderer's constructor and never touches it again. That is right for the
  // colour channels and wrong for alpha: a glyph edge at coverage a lands in
  // the buffer as colour Cs·a with alpha a·a. A WebGL canvas is premultiplied
  // by default, so the compositor reads that as "covers a² of the backdrop"
  // and lets the picture through where the letter should have been — the
  // antialiasing ramp reads thin over bright video, which is exactly where
  // this app is judged. Separate alpha factors leave the colour maths alone
  // and accumulate alpha properly: colour Cs·a, alpha a.
  //
  // Set here rather than left to the addon because the addon has already run
  // its constructor by the time we get here, and re-applied after the tint pass
  // for the same reason — nothing else in the renderer ever sets it back.
  function applyBaseBlend() {
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  function makeTexture(unit) {
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // NEAREST is the same decision as `image-rendering: pixelated` on the CSS
    // path, and for the same measured reason: the field carries hard edges
    // where the ink flips between light and dark, and smoothing them back into
    // a ramp puts mid-grey glyphs on a mid-grey background at exactly that
    // spot — 1.22:1 where the correct answer was 5.97:1.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  // How many cells a glyph occupies. Taken from the CHARACTERS, not from
  // `code`: the render model ORs a combined-character bit into the code before
  // handing it over, so a width derived from it would be nonsense for exactly
  // the multi-cell cases this exists for. Falls back to one cell whenever the
  // service is not reachable — under-marking loses the tint on a wide glyph's
  // right half, over-marking would tint something that is not ours.
  function cellSpan(chars) {
    if (!chars) return 1;
    try {
      const service = term._core && term._core.unicodeService;
      if (service && typeof service.getStringCellWidth === "function") {
        const width = service.getStringCellWidth(chars);
        return width > 1 ? width : 1;
      }
    } catch (e) {
      /* service moved; one cell is the safe answer */
    }
    return 1;
  }

  function resetMask() {
    const cols = Math.max(1, term.cols | 0);
    const rows = Math.max(1, term.rows | 0);
    if (!mask || maskCols !== cols || maskRows !== rows) {
      mask = new Uint8Array(cols * rows);
      maskCols = cols;
      maskRows = rows;
    } else {
      mask.fill(0);
    }
    maskDirty = true;
  }

  // --- the patches ---------------------------------------------------------
  //
  // All of these shadow a method on the INSTANCE, not on the prototype: the
  // patch is then scoped to this terminal and disappears with it, the same
  // shape as the 24-bit cell-background patch in terminal.js. The property
  // names survive the addon's minification (webpack/terser do not mangle
  // property names), which is checked by grep in the bundle rather than assumed.

  function patch() {
    const glyph = renderer._glyphRenderer && renderer._glyphRenderer.value;
    const rect = renderer._rectangleRenderer && renderer._rectangleRenderer.value;
    if (!glyph || !rect) return false;
    if (glyph === patchedGlyph && rect === patchedRect) return true;

    unpatch();
    resetMask();

    const originalUpdateCell = glyph.updateCell;
    const originalClear = glyph.clear;
    const originalRender = glyph.render;

    glyph.updateCell = function (x, y, code, bg, fg, ext, chars, lastBg) {
      const i = y * maskCols + x;
      if (i >= 0 && i < mask.length) {
        let eligible = 0;
        let span = 1;
        const defaultFg = (fg & CM_MASK) === CM_DEFAULT && !(fg & FG_INVERSE);
        if (
          inkOn &&
          defaultFg &&
          code !== 0 &&
          code !== undefined &&
          (bg & CM_MASK) === CM_DEFAULT &&
          !((bg & BG_HAS_EXTENDED) && (ext & CM_MASK) !== CM_DEFAULT)
        ) {
          // Default colours on both sides: this glyph is standing on the
          // picture, so it is ours to colour. Anything else keeps the colour it
          // asked for — an ANSI foreground, a 24-bit foreground, the cursor
          // cell, a selection — exactly as on the CSS path, where a glyph's own
          // declaration always beat the inherited map.
          eligible = 255;
          fg = (fg & ~FG_COLOR_AND_MODE) | WHITE_FG;
          // A width-2 glyph in the BMP starts at U+1100; a single char below
          // that is always one cell, and it is the overwhelming majority of
          // every frame — the unicode service walk is saved for the cells
          // that might actually need it (combined chars, CJK, emoji).
          span =
            chars && (chars.length > 1 || chars.charCodeAt(0) >= 0x1100)
              ? cellSpan(chars)
              : 1;
        } else if (flatInkWord && defaultFg && code !== 0 && code !== undefined) {
          // Default-fg text the ink texture cannot reach — a glyph on a filled
          // cell, or one excluded for its explicit underline colour. On the
          // DOM path these read the live theme foreground; here the theme
          // foreground is pinned (see pinnedFg above), so the flat ink is
          // written into the cell attribute instead. Same key mechanics as an
          // ordinary 24-bit foreground, so the atlas grows one entry per
          // (glyph, background) pair per ADOPTED ink — which is why adoption
          // has its own coarse deadband. With the ink off entirely (map torn
          // down, feed in fallback) this branch also covers the whole shell,
          // which is exactly the flat-colour fallback the CSS path renders.
          fg = (fg & ~FG_COLOR_AND_MODE) | flatInkWord;
        }
        if (mask[i] !== eligible) {
          mask[i] = eligible;
          maskDirty = true;
        }
        // A double-width glyph is ONE bitmap two cells wide, drawn from the
        // left cell; the buffer holds the right one as a null cell carrying the
        // same attributes. That null cell is therefore (0,0,0,0) for ordinary
        // text — exactly what the render model already holds for a blank — so
        // _updateModel skips it and updateCell is never called for it at all.
        // Anything keyed on the right cell's own visit is dead code (an earlier
        // version inherited the mask from the left here, and it never ran).
        // Mark the cells the glyph covers from the left, which is always
        // visited, or the right half of every CJK and emoji glyph keeps the
        // white it was rasterised in.
        for (let s = 1; s < span && x + s < maskCols; s++) {
          if (mask[i + s] !== eligible) {
            mask[i + s] = eligible;
            maskDirty = true;
          }
        }
      }
      return originalUpdateCell.call(this, x, y, code, bg, fg, ext, chars, lastBg);
    };

    glyph.clear = function () {
      const result = originalClear.call(this);
      // The renderer clears its vertices on resize and on every full model
      // reset, and the mask describes exactly those vertices — so it has to be
      // rebuilt at the same moments, at the new grid size.
      resetMask();
      return result;
    };

    glyph.render = function (model) {
      const result = originalRender.call(this, model);
      drawTint();
      return result;
    };

    const originalRenderBackgrounds = rect.renderBackgrounds;
    const originalUpdateRectangle = rect._updateRectangle;

    rect.renderBackgrounds = function () {
      // Rectangle 0 fills the whole grid with the theme background. The DOM
      // path never showed it — `.term-frame .xterm-screen` is forced
      // transparent in styles.css and the panel tint comes from
      // .term-wrapper's own CSS background — and under the tint pass it would
      // be worse than redundant: an opaque quad under an eligible cell is a
      // surface the multiply can reach, so the ink would paint the panel
      // instead of the letters. An assignment, so it stays correct at frame
      // cadence no matter how often _updateViewportRectangle rewrites it.
      if (this._vertices && this._vertices.attributes.length > RECT_ALPHA_INDEX) {
        this._vertices.attributes[RECT_ALPHA_INDEX] = 0;
      }
      return originalRenderBackgrounds.call(this);
    };

    // Every cell-background rectangle passes through here, with the attributes
    // that produced it — which is the only place both facts are available at
    // once, and there are two things to fix with them.
    rect._updateRectangle = function (vertices, offset, fg, bg, startX, endX, y) {
      const result = originalUpdateRectangle.call(
        this, vertices, offset, fg, bg, startX, endX, y,
      );
      const alphaIndex = offset + RECT_ALPHA_INDEX;
      if (alphaIndex >= vertices.attributes.length) return result;
      const inverse = (fg & FG_INVERSE) !== 0;

      // (1) A rectangle is emitted for any cell whose background WORD is
      // non-zero — and that word carries italic, dim, overline and the
      // extended-attribute flag alongside the colour. So italic or dim text
      // with an ordinary background gets a rectangle filled with the theme
      // background at alpha 1: an opaque box behind the letters of a window
      // that is supposed to be see-through, and, under the tint pass, an
      // opaque box the ink would then paint. Default background means "the
      // picture", exactly as it does on the DOM path, so it draws nothing.
      if (!inverse && (bg & CM_MASK) === CM_DEFAULT) {
        vertices.attributes[alphaIndex] = 0;
        return result;
      }

      // (2) Filled cells fade with the opacity slider on the DOM path (0.5.11);
      // this renderer hardcodes their alpha to 1. The block cursor is excluded:
      // it arrives here as an ordinary background (the model swaps fg/bg for
      // the cursor cell rather than drawing a rectangle for it), but on the DOM
      // path it is painted by xterm's own `.xterm-cursor-block` rule, which
      // neither the stylesheet in cell-bg.mjs nor the row-factory patch touches
      // — so it has always been solid and has to stay solid.
      if (cellAlpha < 1 && !(!inverse && bg === cursorBgWord(this))) {
        vertices.attributes[alphaIndex] *= cellAlpha;
      }
      return result;
    };

    // 🔑 webOS reports devicePixelContentBoxSize in CSS PIXELS, not device
    // pixels. The addon observes that box to correct backing-store rounding on
    // fractional device pixel ratios (DevicePixelObserver.ts) and hands the
    // result straight to _setCanvasDevicePixelDimensions, which resizes the
    // drawing buffer and NOTHING else. At dpr 2 that halves the buffer to
    // 1155x624 while gl.viewport, the glyph sizes and the cell offsets all stay
    // in the 2310x1248 space the renderer computed — so the terminal draws at
    // double scale and clipped, which reads as "the font is suddenly huge".
    // Measured in exactly that state on the device: backing 1155x624, viewport
    // 2310x1248, while the link layer (which does not use the observer) sat
    // correctly at 2310x1248.
    //
    // A report that disagrees with the renderer's own device canvas is
    // therefore not a rounding correction, it is a wrong unit — drop it and
    // keep the one coordinate space everything else is expressed in. Reports
    // within a pixel are the fractional-dpr case the observer exists for and
    // still get through.
    const originalSetCanvasDims = renderer._setCanvasDevicePixelDimensions;
    if (typeof originalSetCanvasDims === "function") {
      renderer.__chameleonOriginalSetCanvasDims = originalSetCanvasDims;
      renderer._setCanvasDevicePixelDimensions = function (width, height) {
        const want = this.dimensions && this.dimensions.device && this.dimensions.device.canvas;
        if (want && (Math.abs(width - want.width) > 1 || Math.abs(height - want.height) > 1)) {
          return;
        }
        return originalSetCanvasDims.call(this, width, height);
      };
      patchedRenderer = renderer;
    }

    // 🔑 A bar, underline or outline cursor lives ONLY in the rectangle
    // renderer's separate cursor vertex buffer — unlike a block, which is the
    // cursor cell's own swapped-in background in the render model. And
    // `_updateModel` clears `model.cursor` on entry unconditionally, refilling
    // it only if the row range it was asked to redraw happens to cover the
    // cursor row; it then calls updateCursor() either way, which zeroes the
    // buffer. So every frame caused by a change on OTHER rows alone — a tmux
    // status clock, output scrolling above the prompt — silently dropped the
    // cursor until something touched its row again (measured on the device:
    // model.cursor null in 1 of 5 samples at an idle prompt).
    //
    // A pass that did not redraw the cursor's row carries no information about
    // the cursor, so treat the clear as the artefact it is and put the previous
    // one back. A pass that DID cover the row is authoritative — if it left no
    // cursor, the cursor is genuinely gone (hidden via DECTCEM, or the off
    // phase of a blink, which redraws exactly that row) and it stays gone.
    const originalUpdateModel = renderer._updateModel;
    if (typeof originalUpdateModel === "function") {
      renderer.__chameleonOriginalUpdateModel = originalUpdateModel;
      renderer._updateModel = function (start, end) {
        const previous = this._model && this._model.cursor;
        const result = originalUpdateModel.call(this, start, end);
        if (!previous || !this._model || this._model.cursor) return result;
        let row;
        let buffer;
        try {
          buffer = term.buffer.active;
          row = buffer.baseY + buffer.cursorY - buffer.viewportY;
        } catch (e) {
          return result;
        }
        // Scrolled out of the viewport, so the cursor is genuinely not on
        // screen and there is nothing to restore. `start`/`end` are viewport
        // rows clamped to [0, rows-1], so an off-viewport row is outside EVERY
        // legal range and the test below would restore on every single pass —
        // and each restore becomes the next pass's `previous`, which makes it
        // self-sustaining. RectangleRenderer then draws it at `cursor.y *
        // cellHeight`, i.e. a scrollback row painted at a viewport position: a
        // bar frozen over old text, until the user scrolls back to the bottom.
        // Reachable with the Magic-Remote wheel and through the search bar.
        if (row < 0 || row >= term.rows) return result;
        if (row >= start && row <= end) return result;
        // Restore the cursor's APPEARANCE, never its old position. xterm's
        // _setCursor/_moveCursor do not markDirty, and DirtyRowTracker seeds
        // its range from buffer.y at the START of the parse — so a chunk that
        // only moves the cursor up refreshes the row it LEFT, not the one it
        // went to. Replaying `previous` wholesale then paints the bar a line
        // away from where typing will land, and our own ~25/s ink upload
        // re-paints it there every frame until something dirties the new row.
        // handleCursorMove would have covered it, but it only redraws through
        // restartBlinkAnimation, which is a no-op when the remote asked for a
        // steady cursor (an even DECSCUSR) — i.e. exactly when a misplaced
        // cursor is most visible. Before 0.5.30 this window merely dropped the
        // cursor; a cursor in the wrong place is the worse failure.
        // x, y AND width all come from the live buffer, because all three are
        // properties of WHERE the cursor is. Inheriting width from `previous`
        // was a half-measure: xterm sets it from cell.getWidth() at the cursor
        // cell, and RectangleRenderer multiplies it by the cell width for the
        // underline and outline styles — so a cursor that left a CJK cell for
        // an ASCII one would keep painting a two-cell underline under a
        // one-cell glyph, and repaint it there at the ink cadence until
        // something dirtied the row.
        //
        // `y` uses buffer.cursorY, xterm's own convention (baseY-relative),
        // rather than the viewport row computed above. The two differ only when
        // scrolled back, and the guard above has already returned in that case,
        // so this is the same number written the way the rest of the renderer
        // writes it.
        let width = previous.width;
        try {
          const line = term.buffer.active.getLine(buffer.baseY + buffer.cursorY);
          const cell = line && line.getCell(buffer.cursorX);
          const w = cell && cell.getWidth();
          if (w) width = w;
        } catch (e) {
          /* mid-resize: previous.width is the better guess than nothing */
        }
        this._model.cursor = Object.assign({}, previous, {
          x: Math.min(Math.max(buffer.cursorX, 0), Math.max(0, term.cols - 1)),
          y: buffer.cursorY,
          width,
        });
        const rect = this._rectangleRenderer && this._rectangleRenderer.value;
        if (rect && typeof rect.updateCursor === "function") rect.updateCursor(this._model);
        return result;
      };
      patchedRenderer = renderer;
    }

    // 🔑 Every reactive setTheme was restarting the cursor's blink clock.
    //
    // The addon registers an UNFILTERED `onOptionChange -> _handleOptionsChanged`,
    // and (verified in the shipped bundle, not just the sources) that is
    // `_updateDimensions(); _refreshCharAtlas(); _updateCursorBlink()`, where
    // _updateCursorBlink does `this._cursorBlinkStateManager.value = new
    // CursorBlinkStateManager(...)` with no test of its own. MutableDisposable
    // disposes the old timers and the constructor starts a fresh 600 ms
    // timeout with isCursorVisible = true. OptionsService fires on reference
    // inequality and pinTheme hands back a new object every time, so under a
    // moving picture the ink walks past its repaint deadband several times a
    // second — and 0.5.32 deliberately spreads a big jump over a LONGER settle,
    // which makes the burst denser, not sparser. The cursor then sits solid
    // through every transition and half-blinks under drift: the symptom 0.5.30
    // says it fixed, present again but only while the headline feature is on.
    // (Invisible before 0.5.30 because isFocused was false, so the interval
    // never armed at all.)
    //
    // Skip only the blink half, and only when the option did not actually move.
    // _updateDimensions has to keep running (font size and dpr changes arrive
    // through this same handler), and _refreshCharAtlas is left alone on
    // purpose: it is the only path for the non-theme colour options, and with
    // the foreground pinned its 256-way compare finds the config equal and
    // returns without disposing anything.
    //
    // ⚠️ AND skip only while the blink is genuinely RUNNING. In this app
    // _updateCursorBlink is not merely "restart the clock", it is the only way
    // an interval can ever be armed at all: CursorBlinkStateManager arms in its
    // constructor and only `if (isFocused)`, restartBlinkAnimation early-returns
    // on a paused manager, and the one un-pause path (renderer.handleFocus ←
    // onFocus ← the helper textarea) is structurally dead here because that
    // textarea is disabled by the OSK fix. So a manager built while
    // document.hasFocus() is false is permanently paused — and an overlay show
    // over another fullscreen app builds exactly that, because activateApp is
    // async and the renderer is created before the WebView has focus. Skipping
    // unconditionally would then leave a solid block for the rest of the
    // session: the symptom 0.5.30 exists to kill, reintroduced by its own fix.
    // Letting the original through while paused restores the arming path and
    // still kills the churn, because once armed isPaused is false forever after.
    const originalOptionsChanged = renderer._handleOptionsChanged;
    if (typeof originalOptionsChanged === "function") {
      renderer.__chameleonOriginalOptionsChanged = originalOptionsChanged;
      let lastCursorBlink = term.options ? term.options.cursorBlink : undefined;
      renderer._handleOptionsChanged = function () {
        const blink = term.options ? term.options.cursorBlink : undefined;
        const holder = this._cursorBlinkStateManager;
        const manager = holder && holder.value;
        const needsArming = Boolean(blink) && (!manager || manager.isPaused);
        if (blink !== lastCursorBlink || needsArming) {
          lastCursorBlink = blink;
          return originalOptionsChanged.call(this);
        }
        this._updateDimensions();
        this._refreshCharAtlas();
      };
      patchedRenderer = renderer;
    }

    glyph.__chameleonOriginals = {
      updateCell: originalUpdateCell,
      clear: originalClear,
      render: originalRender,
    };
    rect.__chameleonOriginals = {
      renderBackgrounds: originalRenderBackgrounds,
      _updateRectangle: originalUpdateRectangle,
    };
    patchedGlyph = glyph;
    patchedRect = rect;

    // The bad report may already have landed before the guard was in place —
    // the observer fires a frame or two after the canvas is built, and this
    // runs on activation and again after every renderer rebuild. Put the
    // drawing buffer back to the size the rest of the renderer is drawing for.
    const want = renderer.dimensions && renderer.dimensions.device && renderer.dimensions.device.canvas;
    const canvas = renderer._canvas;
    if (want && canvas && want.width > 0 && (canvas.width !== want.width || canvas.height !== want.height)) {
      try {
        renderer.handleResize(term.cols, term.rows);
      } catch (e) {
        /* dimensions not measurable yet; the next resize settles it */
      }
    }
    return true;
  }

  function unpatch() {
    if (patchedGlyph && patchedGlyph.__chameleonOriginals) {
      Object.assign(patchedGlyph, patchedGlyph.__chameleonOriginals);
      delete patchedGlyph.__chameleonOriginals;
    }
    if (patchedRect && patchedRect.__chameleonOriginals) {
      Object.assign(patchedRect, patchedRect.__chameleonOriginals);
      delete patchedRect.__chameleonOriginals;
    }
    if (patchedRenderer && patchedRenderer.__chameleonOriginalSetCanvasDims) {
      patchedRenderer._setCanvasDevicePixelDimensions =
        patchedRenderer.__chameleonOriginalSetCanvasDims;
      delete patchedRenderer.__chameleonOriginalSetCanvasDims;
    }
    if (patchedRenderer && patchedRenderer.__chameleonOriginalUpdateModel) {
      patchedRenderer._updateModel = patchedRenderer.__chameleonOriginalUpdateModel;
      delete patchedRenderer.__chameleonOriginalUpdateModel;
    }
    if (patchedRenderer && patchedRenderer.__chameleonOriginalOptionsChanged) {
      patchedRenderer._handleOptionsChanged = patchedRenderer.__chameleonOriginalOptionsChanged;
      delete patchedRenderer.__chameleonOriginalOptionsChanged;
    }
    patchedGlyph = null;
    patchedRect = null;
    patchedRenderer = null;
  }

  // --- the tint pass -------------------------------------------------------

  function drawTint() {
    if (!inkOn || !inkReady || tintFailed || !alive()) return;
    try {
      if (maskDirty) {
        gl.activeTexture(gl.TEXTURE0 + maskUnit);
        gl.bindTexture(gl.TEXTURE_2D, maskTexture);
        gl.texImage2D(
          gl.TEXTURE_2D, 0, gl.R8, maskCols, maskRows, 0, gl.RED, gl.UNSIGNED_BYTE, mask,
        );
        maskDirty = false;
      }
      gl.useProgram(program);
      gl.bindVertexArray(vao);
      gl.activeTexture(gl.TEXTURE0 + inkUnit);
      gl.bindTexture(gl.TEXTURE_2D, inkTexture);
      gl.activeTexture(gl.TEXTURE0 + maskUnit);
      gl.bindTexture(gl.TEXTURE_2D, maskTexture);
      // dst.rgb *= src.rgb, dst.a left alone. Multiply is what makes the pass
      // self-masking: a transparent pixel stays transparent whatever the ink is.
      gl.blendFuncSeparate(gl.ZERO, gl.SRC_COLOR, gl.ZERO, gl.ONE);
      try {
        gl.drawElements(gl.TRIANGLE_STRIP, 4, gl.UNSIGNED_BYTE, 0);
      } finally {
        // Put back the state the rest of the renderer assumes, on every exit
        // including a thrown one. Nothing else ever sets the blend function, so
        // ours left behind would multiply the cursor drawn right after this and
        // every glyph of every later frame into the buffer — the window would
        // empty out to the bare panel tint and stay that way.
        applyBaseBlend();
      }
      gl.bindVertexArray(null);
      if (restoreAtlasUnits) restoreAtlasBindings();
      gl.activeTexture(gl.TEXTURE0);
    } catch (e) {
      // A broken tint must never take the terminal's text down with it. The
      // glyphs eligible for ink are rasterised white, so leaving it at that
      // would be a white screen: put them back on their real colours.
      tintFailed = true;
      inkOn = false;
      debug("ui_webgl_tint_error", { error: String((e && e.message) || e) });
      // Out of the render call this is running inside, so the model is not
      // rebuilt underneath a renderer that is still on the stack.
      setTimeout(() => {
        try {
          if (renderer && typeof renderer.clear === "function") renderer.clear();
          requestRedraw();
        } catch (e2) {
          /* nothing further to salvage here */
        }
      }, 0);
    }
  }

  // The bg word the model writes for the block-cursor cell: an RGB background
  // in the theme's cursor colour. Read live rather than cached — the Chameleon
  // spark moves the cursor colour while the feed runs.
  function cursorBgWord(rectRenderer) {
    try {
      const cursor = rectRenderer._themeService.colors.cursor;
      return CM_RGB | ((cursor.rgba >>> 8) & 0xffffff);
    } catch (e) {
      return -1; // matches no bg word, so the slider simply also fades it
    }
  }

  function restoreAtlasBindings() {
    const glyph = renderer && renderer._glyphRenderer && renderer._glyphRenderer.value;
    const textures = glyph && glyph._atlasTextures;
    if (!textures) return;
    for (let i = 0; i < 2 && i < textures.length; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, textures[i].texture);
    }
  }

  // full=false marks one row dirty instead of all of them. renderRows updates
  // the MODEL only for the rows asked for and then draws the whole vertex
  // buffer regardless (WebglRenderer.renderRows), so when nothing about the
  // cells changed — a fresh ink texture is the only difference — one row is
  // enough to get a full present, without walking every cell of the viewport
  // per upload at the solve cadence.
  function requestRedraw(full = true) {
    try {
      term.refresh(0, full ? Math.max(0, term.rows - 1) : 0);
    } catch (e) {
      /* terminal mid-teardown */
    }
  }

  // Re-establishes everything that a context loss or a renderer rebuild would
  // have taken away. Cheap enough to call on every ink update, which is what
  // makes recovery automatic instead of a special case.
  function ensure() {
    const current = currentRenderer();
    if (!current) return false;
    if (current !== renderer) {
      // Release against the context the objects were made in, before adopting
      // the new one: deleting one context's buffers through another's handle is
      // undefined at best.
      releaseGl();
      renderer = current;
      patchedGlyph = null;
      patchedRect = null;
      gl = renderer._gl;
    }
    if (!gl || gl.isContextLost()) return false;
    if (!alive()) {
      try {
        initGl();
      } catch (e) {
        debug("ui_webgl_init_error", { error: String((e && e.message) || e) });
        return false;
      }
    }
    return patch();
  }

  return {
    /** Turn the WebGL renderer on. False means the caller keeps the DOM one. */
    enable() {
      if (addon) return true;
      // A device that has no usable WebGL2 will not grow one between two
      // overlay shows, and every attempt builds a canvas and a context to fail
      // with. Latched for the life of this terminal.
      if (activationFailed) return false;
      try {
        addon = new WebglAddon();
        term.loadAddon(addon);
      } catch (e) {
        // No WebGL2, a driver that refused the context, or an addon that could
        // not attach. The DOM renderer is still in place and the CSS ink path
        // still works; this is a downgrade, not a failure. Dispose rather than
        // just dropping the reference: a half-constructed addon may already
        // hold a GL context and a canvas in the DOM.
        try {
          if (addon) addon.dispose();
        } catch (e2) {
          /* never attached */
        }
        addon = null;
        activationFailed = true;
        debug("ui_webgl_unavailable", { error: String((e && e.message) || e) });
        return false;
      }
      renderer = currentRenderer();
      if (!renderer) {
        debug("ui_webgl_unavailable", { error: "renderer not swapped" });
        this.disable();
        return false;
      }
      gl = renderer._gl;
      tintFailed = false;
      // A context that comes BACK is the dangerous case, not one that stays
      // lost. xterm's own handler rebuilds the rectangle and glyph renderers
      // (_initializeWebGLState), so every instance patch is left behind on the
      // discarded objects: the viewport quad goes opaque again — the panel
      // stops being see-through, which is the whole feature — cell alpha stops
      // applying, and the new glyph renderer's constructor resets the blend
      // function. Nothing else would notice: onContextLoss only fires when the
      // restore does NOT arrive, setGlyphRenderer returns early while the addon
      // is still attached, and a static picture means no solve and so no
      // setInk. This listener is registered after xterm's, so it runs after the
      // rebuild it has to repair.
      if (renderer._canvas && typeof renderer._canvas.addEventListener === "function") {
        lostListener = () => {
          debug("ui_webgl_context_lost_event", {});
          // The objects are gone with the context; forget them rather than
          // deleting them, and stop whitening glyphs the tint can no longer
          // colour.
          forgetGl();
        };
        renderer._canvas.addEventListener("webglcontextlost", lostListener);
        restoreListener = () => {
          debug("ui_webgl_context_restored", {});
          if (ensure()) {
            // Rebuilds the mask and re-whitens through the patched updateCell.
            try {
              renderer.clear();
            } catch (e) {
              /* renderer mid-rebuild */
            }
            requestRedraw();
          }
        };
        renderer._canvas.addEventListener("webglcontextrestored", restoreListener);
      }
      if (typeof addon.onContextLoss === "function") {
        // The addon holds the canvas listener that waits three seconds for a
        // restore; this fires only once that has failed, and the only sane
        // answer then is to hand rendering back to the DOM.
        addon.onContextLoss(() => {
          debug("ui_webgl_context_lost", {});
          this.disable();
        });
      }
      if (!ensure()) {
        debug("ui_webgl_unavailable", { error: "patch failed" });
        this.disable();
        return false;
      }
      // Freeze the atlas key on whatever theme is live right now — the base
      // shell on a normal activation, the last derived one on a re-enable
      // mid-feed. Which value it is does not matter; that it never changes
      // again does. The flat ink starts on the same colour so a screen drawn
      // before the first feed frame looks exactly like the theme it came from.
      try {
        const fg = term.options && term.options.theme && term.options.theme.foreground;
        if (fg) {
          pinnedFg = fg;
          writeFlatInk(fg);
        }
      } catch (e) {
        /* theme not readable; pinTheme freezes on the first palette instead */
      }
      debug("ui_webgl_active", {
        renderer: rendererName(),
        cols: term.cols,
        rows: term.rows,
      });
      return true;
    },

    /** Back to the DOM renderer. Safe to call when never enabled. */
    disable() {
      inkOn = false;
      // The DOM renderer reads the live theme foreground again; the caller's
      // next setTheme must reach xterm unpinned.
      pinnedFg = null;
      flatInkWord = 0;
      flatInkHex = null;
      unpatch();
      if (renderer && renderer._canvas) {
        if (restoreListener) {
          renderer._canvas.removeEventListener("webglcontextrestored", restoreListener);
        }
        if (lostListener) {
          renderer._canvas.removeEventListener("webglcontextlost", lostListener);
        }
      }
      restoreListener = null;
      lostListener = null;
      releaseGl();
      const dying = addon;
      addon = null;
      renderer = null;
      gl = null;
      mask = null;
      maskCols = 0;
      maskRows = 0;
      if (!dying) return;
      try {
        // Disposing restores the DOM renderer through
        // renderService.setRenderer(core._createRenderer()) and resizes it.
        dying.dispose();
      } catch (e) {
        /* already gone with the terminal */
      }
      if (typeof onDomRestored === "function") {
        try {
          onDomRestored();
        } catch (e) {
          /* the terminal is mid-teardown; nothing left to repair */
        }
      }
    },

    active() {
      return Boolean(addon && renderer);
    },

    /** The box the glyphs are drawn in — the WebGL stand-in for .xterm-rows. */
    canvasElement() {
      return (renderer && renderer._canvas) || null;
    },

    /**
     * Hand over a solved ink field (ink-map.mjs renderInkTexture), or null to
     * put the glyphs back on the theme foreground.
     */
    setInk(texture) {
      if (!texture || !texture.w || !texture.h) {
        if (!inkOn) return;
        inkOn = false;
        inkReady = false;
        // The cells were rasterised white while the ink was live; they have to
        // go back through the atlas with their real colours before anything is
        // drawn again, or the shell would be a screenful of white text.
        if (renderer && typeof renderer.clear === "function") renderer.clear();
        requestRedraw();
        return;
      }
      // A tint that has already thrown once stays off: turning the ink back on
      // would rasterise the glyphs white again with nothing left to colour
      // them, which is a screenful of white text rather than a lost effect.
      if (tintFailed || !ensure()) return;
      const wasOn = inkOn;
      gl.activeTexture(gl.TEXTURE0 + inkUnit);
      gl.bindTexture(gl.TEXTURE_2D, inkTexture);
      if (texture.w === inkW && texture.h === inkH) {
        gl.texSubImage2D(
          gl.TEXTURE_2D, 0, 0, 0, texture.w, texture.h,
          gl.RGB, gl.UNSIGNED_BYTE, texture.data,
        );
      } else {
        gl.texImage2D(
          gl.TEXTURE_2D, 0, gl.RGB, texture.w, texture.h, 0,
          gl.RGB, gl.UNSIGNED_BYTE, texture.data,
        );
        inkW = texture.w;
        inkH = texture.h;
      }
      // The upload left our texture bound where an atlas page belongs on the
      // fallback path, and the next frame's glyph draw comes before the tint
      // pass that would have put it back.
      if (restoreAtlasUnits) restoreAtlasBindings();
      inkReady = true;
      inkOn = true;
      if (!wasOn && renderer && typeof renderer.clear === "function") {
        // First frame of the effect: every cell already on screen was
        // rasterised in its own colour and has to be re-resolved as white.
        renderer.clear();
      }
      // Steady state needs no cell walk — only the texture moved.
      requestRedraw(!wasOn);
    },

    /**
     * Rewrites a theme so xterm's atlas config never changes while this
     * renderer is live: the foreground is held at the value it had when the
     * renderer was enabled, and the palette's real foreground is carried as
     * the flat ink instead (see the comment on pinnedFg). Everything else in
     * the palette passes through untouched. Callers hand EVERY palette through
     * here while active — including the static fallback shell — so the flat
     * fallback keeps its solved colour without ever re-keying the atlas.
     */
    pinTheme(palette) {
      if (!palette || !palette.foreground) return palette;
      if (!pinnedFg) pinnedFg = palette.foreground;
      // Adoption, not tracking: each adopted ink re-rasterises the filled-cell
      // glyph variants once (the setTheme caller refreshes right after), so
      // drift below the adoption distance keeps the previous ink — at that
      // distance the difference is invisible on a status bar.
      if (
        !flatInkHex ||
        (palette.foreground !== flatInkHex &&
          oklabDistance(palette.foreground, flatInkHex) >= FLAT_INK_ADOPT_DISTANCE)
      ) {
        writeFlatInk(palette.foreground);
      }
      if (palette.foreground === pinnedFg) return palette;
      return Object.assign({}, palette, { foreground: pinnedFg });
    },

    /**
     * Take this palette's foreground as the flat ink NOW, deadband or no
     * deadband. For a deliberate theme change, which is a different kind of
     * event from the feed drifting.
     *
     * Without it the theme button is dead on the text. The deadband exists to
     * ration the feed's continuous drift, and 0.5.31 removed the other route by
     * hanging the renderer on the effect toggle instead of the theme — so a
     * theme switch stopped running disable()/enable(), which was the only thing
     * that cleared flatInkHex. What is left cannot do the job: the five themes'
     * foregrounds are all within 0.106 OKLab of each other and the deadband is
     * 0.12, so no theme change on the registry can ever clear it. With the ink
     * texture off (no daemon, feed lost, before the first solve) that branch is
     * the sole colour source for every default-fg glyph, and the body text keeps
     * the old theme's grey for the rest of the session while everything around
     * it changes.
     *
     * Costs nothing extra at the call site: a theme change moves `background`
     * and the 256 ansi slots, so xterm's configEquals throws the atlas out on
     * that setTheme regardless — the re-raster this deadband rations is already
     * being paid. Deliberately does NOT touch pinnedFg: that pin is what keeps
     * every FEED-driven setTheme cheap, and re-pinning here would hand the
     * atlas a new key on top of the one the theme change already invalidated.
     */
    adoptFlatInk(palette) {
      if (!palette || !palette.foreground) return;
      if (palette.foreground === flatInkHex) return;
      writeFlatInk(palette.foreground);
      // Filled cells are resolved in updateCell, so the value only reaches the
      // screen when the model is walked again. The caller's setTheme does that
      // — but not when the palette is otherwise identical, which is exactly the
      // "effect off, static shell" case this exists for.
      requestRedraw(true);
    },

    /** Filled-cell alpha for the opacity slider (0.5.11). */
    setCellAlpha(alpha) {
      const next = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;
      if (next === cellAlpha) return;
      cellAlpha = next;
      if (!patchedRect || !renderer) return;
      try {
        // The rectangles are only rebuilt when the model changes, and moving a
        // slider changes no text — so they have to be rebuilt here or the
        // slider would do nothing until the next line of output.
        patchedRect.updateBackgrounds(renderer._model);
      } catch (e) {
        /* renderer mid-rebuild; the next model update picks the value up */
      }
      requestRedraw(false);
    },

    dispose() {
      this.disable();
    },
  };

  function rendererName() {
    try {
      const info = gl.getExtension("WEBGL_debug_renderer_info");
      return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "webgl2";
    } catch (e) {
      return "webgl2";
    }
  }
}
