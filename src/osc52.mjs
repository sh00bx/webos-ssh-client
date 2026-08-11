// OSC 52 clipboard payload parsing ("<selection>;<base64>"), pure and
// node-testable. Remote programs (tmux set-clipboard, vim/nvim clipboard
// providers) emit this to place text on the local clipboard.
//
// Only the write direction is supported. A "?" payload is a clipboard QUERY —
// answering it would send the TV clipboard to the remote, which is a data
// leak the user never sees, so queries are deliberately ignored.

// Cap the accepted base64 length. A runaway or malicious remote could
// otherwise stream megabytes into the clipboard through what looks like
// terminal output. 100 KiB of base64 ≈ 75 KiB of text — plenty for any
// legitimate copy.
export const OSC52_MAX_BASE64_LENGTH = 100 * 1024;

export function clipboardTextFromOsc52(payload, options = {}) {
  const maxBase64 = Number.isFinite(options.maxBase64Length)
    ? options.maxBase64Length
    : OSC52_MAX_BASE64_LENGTH;
  if (typeof payload !== "string") return null;
  const sep = payload.indexOf(";");
  if (sep < 0) return null;
  // The selection field ("c", "p", "s", digits, or empty) is irrelevant here:
  // the web platform exposes exactly one clipboard, so every selection maps
  // onto it.
  const data = payload.slice(sep + 1);
  if (!data || data === "?") return null;
  if (data.length > maxBase64) return null;
  let bytes;
  try {
    const bin = atob(data);
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch (e) {
    return null; // not base64 — malformed sequence, drop it
  }
  try {
    return new TextDecoder("utf-8").decode(bytes);
  } catch (e) {
    return null;
  }
}
