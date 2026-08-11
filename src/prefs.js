// All localStorage-backed preferences in one place. Every storage key string
// and version below is load-bearing: changing one silently loses the user's
// persisted window geometry, opacity, keybar state or connection profiles.
import { clampFontSize, TERMINAL_FONT_SIZE_LIMITS } from "./terminal.js";

const DEBUG_STORAGE_KEY = "ssh-client.debug";
const WINDOW_STORAGE_KEY = "ssh-client.terminal.window";
const WINDOW_STORAGE_VERSION = 3;
const FONT_SIZE_STORAGE_KEY = "ssh-client.terminal.fontSize";
const KEYBAR_STORAGE_KEY = "ssh-client.terminal.keybar";
const OPACITY_STORAGE_KEY = "ssh-client.terminal.opacity";
const LAST_CONNECT_KEY = "ssh-client.last-connect";
const PROFILES_KEY = "ssh-client.profiles";
export const MAX_PROFILES = 8;

// Panel opacity is a continuous percentage driven by the toolbar slider; it
// maps 1:1 onto --term-alpha on .term-wrapper. The floor keeps the shell
// readable — below ~20% text sits directly on live TV.
export const OPACITY_MIN = 20;
export const OPACITY_MAX = 100;
export const OPACITY_STEP = 5;
export const OPACITY_DEFAULT = 86;
// Pre-slider builds stored a named level; map those onto the scale once.
const OPACITY_LEGACY_LEVELS = { solid: 86, light: 62, glass: 38, ghost: 20 };

// Whether the reactive backdrop effect runs at all (the toggle beside the flash
// slider). On by default — it is what the themes are designed around — and off
// is a complete stop: no feed subscription, no WebGL renderer, every theme back
// to its static palette. The key is deliberately NOT in the chameleon
// namespace: the effect is no longer one theme's.
const REACTIVE_STORAGE_KEY = "ssh-client.reactive";
export const REACTIVE_DEFAULT = true;

// How loud that effect is allowed to be (long-press on the theme button). 50 is
// the tuning that shipped before the knob existed — the mapping onto actual
// chroma numbers lives in color.mjs (flashParams), and each theme scales it
// once more by its own multiplier (themes.mjs).
const FLASH_STORAGE_KEY = "ssh-client.chameleon.flash";
export const FLASH_MIN = 0;
export const FLASH_MAX = 100;
export const FLASH_STEP = 5;
export const FLASH_DEFAULT = 50;

// How gently that effect follows the picture (the second slider in the same
// popover). One number picks a point in every settling range at once — the
// mapping onto milliseconds per surface lives in smoothing.mjs, and so does the
// exact sense in which 0 means "what shipped before the smoothing engine"
// (exactly, on the slow luna path; approximately and only for drift on the
// video wire, because the old tuning there answered cuts with a separate fast
// path). 50 is the default because the complaint this answers is that hard
// scene cuts arrive as a step change, and half the travel is already a visible
// crossfade.
const SMOOTHING_STORAGE_KEY = "ssh-client.reactive.smoothing";
export const SMOOTHING_MIN = 0;
export const SMOOTHING_MAX = 100;
export const SMOOTHING_STEP = 5;
export const SMOOTHING_DEFAULT = 50;

// The four storage primitives. localStorage may be disabled or over quota on
// the TV; every accessor degrades to its fallback instead of throwing.
function readStored(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : raw;
  } catch (e) {
    return fallback;
  }
}

function writeStored(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    /* ignore quota / disabled storage */
  }
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (e) {
    /* ignore quota / disabled storage */
  }
}

export function clampOpacityPercent(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return OPACITY_DEFAULT;
  return Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, n));
}

export function loadOpacityPercent() {
  const raw = readStored(OPACITY_STORAGE_KEY, null);
  if (raw == null) return OPACITY_DEFAULT;
  if (Object.prototype.hasOwnProperty.call(OPACITY_LEGACY_LEVELS, raw)) {
    return OPACITY_LEGACY_LEVELS[raw];
  }
  return clampOpacityPercent(raw);
}

export function saveOpacityPercent(percent) {
  writeStored(OPACITY_STORAGE_KEY, String(percent));
}

// Block-shading ramp for the glyph next to the slider: fuller block = more
// opaque panel.
export function opacityGlyphFor(percent) {
  if (percent >= 80) return "█";
  if (percent >= 55) return "▓";
  if (percent >= 35) return "▒";
  return "░";
}

export function clampFlashPercent(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return FLASH_DEFAULT;
  return Math.min(FLASH_MAX, Math.max(FLASH_MIN, n));
}

export function loadFlashPercent() {
  const raw = readStored(FLASH_STORAGE_KEY, null);
  if (raw == null) return FLASH_DEFAULT;
  return clampFlashPercent(raw);
}

export function saveFlashPercent(percent) {
  writeStored(FLASH_STORAGE_KEY, String(clampFlashPercent(percent)));
}

export function clampSmoothingPercent(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return SMOOTHING_DEFAULT;
  return Math.min(SMOOTHING_MAX, Math.max(SMOOTHING_MIN, n));
}

export function loadSmoothingPercent() {
  const raw = readStored(SMOOTHING_STORAGE_KEY, null);
  if (raw == null) return SMOOTHING_DEFAULT;
  return clampSmoothingPercent(raw);
}

export function saveSmoothingPercent(percent) {
  writeStored(SMOOTHING_STORAGE_KEY, String(clampSmoothingPercent(percent)));
}

export function loadReactiveEnabled() {
  const raw = readStored(REACTIVE_STORAGE_KEY, null);
  if (raw == null) return REACTIVE_DEFAULT;
  return raw === "1";
}

export function saveReactiveEnabled(enabled) {
  writeStored(REACTIVE_STORAGE_KEY, enabled ? "1" : "0");
}

export function loadKeyBarVisible() {
  return readStored(KEYBAR_STORAGE_KEY, "") === "1";
}

export function saveKeyBarVisible(visible) {
  writeStored(KEYBAR_STORAGE_KEY, visible ? "1" : "0");
}

export function loadFontSize() {
  const raw = readStored(FONT_SIZE_STORAGE_KEY, null);
  if (!raw) return TERMINAL_FONT_SIZE_LIMITS.default;
  const value = Number(raw);
  if (!Number.isFinite(value)) return TERMINAL_FONT_SIZE_LIMITS.default;
  return clampFontSize(value);
}

export function saveFontSize(value) {
  writeStored(FONT_SIZE_STORAGE_KEY, String(clampFontSize(value)));
}

export function loadWindowState() {
  const parsed = readJson(WINDOW_STORAGE_KEY, null);
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.version !== WINDOW_STORAGE_VERSION) return null;
  return {
    width: Number.isFinite(parsed.width) ? Number(parsed.width) : null,
    height: Number.isFinite(parsed.height) ? Number(parsed.height) : null,
    right: Number.isFinite(parsed.right) ? Number(parsed.right) : null,
    bottom: Number.isFinite(parsed.bottom) ? Number(parsed.bottom) : null,
    fullscreen: parsed.fullscreen === true,
  };
}

export function saveWindowState(state) {
  writeJson(WINDOW_STORAGE_KEY, {
    ...(state || {}),
    version: WINDOW_STORAGE_VERSION,
  });
}

export function loadDebugEnabled() {
  try {
    const params = new URLSearchParams(window.location.search || "");
    if (params.get("debug") === "1") {
      localStorage.setItem(DEBUG_STORAGE_KEY, "1");
      return true;
    }
    return localStorage.getItem(DEBUG_STORAGE_KEY) === "1";
  } catch (e) {
    return false;
  }
}

export function setDebugEnabledFlag() {
  writeStored(DEBUG_STORAGE_KEY, "1");
}

export function loadLastConnect() {
  const parsed = readJson(LAST_CONNECT_KEY, {});
  return parsed && typeof parsed === "object" ? parsed : {};
}

export function saveLastConnect(values) {
  writeJson(LAST_CONNECT_KEY, {
    host: values.host,
    port: values.port,
    user: values.user,
    authType: values.authType,
    keyId: values.keyId || null,
  });
}

export function normalizeProfile(p) {
  return {
    host: String((p && p.host) || ""),
    port: String((p && p.port) || 22),
    user: String((p && p.user) || ""),
    authType: p && p.authType === "publickey" ? "publickey" : "password",
    keyId: String((p && p.keyId) || ""),
  };
}

export function loadProfiles() {
  const arr = readJson(PROFILES_KEY, []);
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((p) => p && typeof p === "object" && p.host)
    .slice(0, MAX_PROFILES)
    .map(normalizeProfile);
}

export function saveProfiles(profiles) {
  writeJson(PROFILES_KEY, profiles.slice(0, MAX_PROFILES));
}

// Most-recently-used first, deduped by user@host:port.
export function upsertProfile(profiles, entry) {
  const keyOf = (p) => `${p.user}@${p.host}:${p.port}`;
  const normalized = normalizeProfile(entry);
  const rest = profiles.filter((p) => keyOf(p) !== keyOf(normalized));
  return [normalized, ...rest].slice(0, MAX_PROFILES);
}
