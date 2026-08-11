export const KEYBOARD_LAYOUT_MODES = ["auto", "system", "de", "us"];

const KEYBOARD_LAYOUT_LABELS = {
  auto: "AUTO",
  system: "OS",
  de: "DE",
  us: "US",
};

export function normalizeKeyboardLayout(value) {
  const requested = String(value || "auto")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
  return KEYBOARD_LAYOUT_MODES.includes(requested) ? requested : "auto";
}

export function keyboardLayoutLabel(value) {
  return KEYBOARD_LAYOUT_LABELS[normalizeKeyboardLayout(value)];
}

export function nextKeyboardLayout(value) {
  const current = normalizeKeyboardLayout(value);
  const index = KEYBOARD_LAYOUT_MODES.indexOf(current);
  return KEYBOARD_LAYOUT_MODES[(index + 1) % KEYBOARD_LAYOUT_MODES.length];
}

export function resolveKeyboardLayout(value, env = {}) {
  const mode = normalizeKeyboardLayout(value);
  if (mode !== "auto") return mode;

  const languages = Array.isArray(env.languages)
    ? env.languages
    : browserLanguages();
  return languages.some((language) => /^de(?:[-_]|$)/i.test(String(language)))
    ? "de"
    : "system";
}

function browserLanguages() {
  const languages = [];
  if (typeof navigator === "undefined") return [];
  if (Array.isArray(navigator.languages) && navigator.languages.length) {
    languages.push(...navigator.languages);
  }
  if (navigator.language) languages.push(navigator.language);
  if (
    typeof Intl !== "undefined" &&
    Intl.DateTimeFormat &&
    typeof Intl.DateTimeFormat === "function"
  ) {
    try {
      const locale = Intl.DateTimeFormat().resolvedOptions().locale;
      if (locale) languages.push(locale);
    } catch (e) {
      /* locale APIs may be incomplete on old webOS WebKit */
    }
  }
  return languages;
}
