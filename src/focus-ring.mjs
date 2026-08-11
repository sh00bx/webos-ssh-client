// Focus traversal arithmetic for the connect form, kept apart from the DOM so
// it can be tested without a browser.
//
// The form is driven by a TV remote. There is no Tab key on it, so every
// focusable control — text fields, the pickers, the auth switch and all the
// buttons — has to sit on one vertical ring that Up/Down walks. Left/Right is
// already spoken for on the controls that own it (caret movement inside a text
// field, value cycling on a picker), which is exactly why the ring has to be
// vertical and why it has to include everything.

/**
 * Next element on the vertical ring. Wraps, because a ring on a remote is what
 * lets you reach the Connect button from the top of the form with one held
 * key rather than eleven presses in the other direction.
 *
 * An `active` that is not in the list (focus parked on <body> after a control
 * was removed) enters at the end the caller is travelling from.
 */
export function nextInRing(items, active, step) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const at = items.indexOf(active);
  if (at < 0) return step > 0 ? items[0] : items[items.length - 1];
  return items[(at + step + items.length) % items.length];
}

/**
 * Next control within one row (the SSH/SCP/Connect line, the minor button
 * line, a session's Attach/End pair).
 *
 * Deliberately does NOT wrap: rows are two or three controls wide, and a
 * Left that jumps from the first to the last reads as a glitch rather than as
 * travel. Returning null at the edges also leaves the ring as the only thing
 * that moves focus in a circle.
 */
export function nextInRow(items, active, step) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const at = items.indexOf(active);
  if (at < 0) return null;
  const next = at + step;
  return next >= 0 && next < items.length ? items[next] : null;
}
