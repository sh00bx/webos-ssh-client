// The on-screen-keyboard input path (src/osk-input.mjs). What is checked here
// is the diff that turns a proxy textarea's value changes into terminal bytes
// — the part that has to be right for typing with a Magic Remote to work at
// all, and the part that cannot be tested on the device without a person
// holding the remote.
import assert from "node:assert/strict";
import {
  KEYBOARD_STATE_EVENT,
  REMOTE_OSK_ENTER_KEYCODE,
  isOskEnterEvent,
  keyboardVisibleFromEvent,
  proxyInputDelta,
  systemKeyboardVisible,
} from "../src/osk-input.mjs";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL - ${name}: ${(e && e.message) || e}`);
  }
}

check("typing at the end sends only what was added", () => {
  assert.equal(proxyInputDelta("", "l"), "l");
  assert.equal(proxyInputDelta("l", "ls"), "s");
  assert.equal(proxyInputDelta("ls", "ls -la"), " -la");
});

check("a predictive-text commit arrives as one insert", () => {
  // The webOS OSK replaces the whole word when a suggestion is accepted; the
  // shared prefix is what keeps that from re-sending characters already sent.
  assert.equal(proxyInputDelta("sys", "systemctl"), "temctl");
});

check("backspace becomes DEL, one per character", () => {
  assert.equal(proxyInputDelta("ls", "l"), "\x7f");
  assert.equal(proxyInputDelta("ls -la", "ls"), "\x7f\x7f\x7f\x7f");
  assert.equal(proxyInputDelta("abc", ""), "\x7f\x7f\x7f");
});

check("an edit in the middle rewinds and retypes the tail", () => {
  // Documented behaviour, not an accident: the shell has no idea where the
  // proxy field's caret is, so reaching the same end state means deleting back
  // to the change. "abXc" from "abc" = one delete (the c) plus "Xc".
  assert.equal(proxyInputDelta("abc", "abXc"), "\x7fXc");
});

check("no change sends nothing", () => {
  assert.equal(proxyInputDelta("ls -la", "ls -la"), "");
  assert.equal(proxyInputDelta("", ""), "");
});

check("umlauts and emoji are one character, not two code units", () => {
  // The reason the diff walks code points: cutting a surrogate pair would put
  // half a character on the wire, and one press of the OSK's backspace on an
  // emoji has to be ONE delete.
  assert.equal(proxyInputDelta("ä", "äö"), "ö");
  assert.equal(proxyInputDelta("äö", "ä"), "\x7f");
  assert.equal(proxyInputDelta("", "🐧"), "🐧");
  assert.equal(proxyInputDelta("🐧", ""), "\x7f");
  assert.equal(proxyInputDelta("a🐧", "a"), "\x7f");
});

check("non-string input is treated as empty rather than throwing", () => {
  assert.equal(proxyInputDelta(null, "hi"), "hi");
  assert.equal(proxyInputDelta(undefined, undefined), "");
});

check("the remote's OSK confirm key counts as Enter", () => {
  assert.equal(REMOTE_OSK_ENTER_KEYCODE, 16777221);
  assert.equal(isOskEnterEvent({ keyCode: REMOTE_OSK_ENTER_KEYCODE }), true);
  assert.equal(isOskEnterEvent({ key: "Enter" }), true);
  assert.equal(isOskEnterEvent({ keyCode: 13 }), true);
  assert.equal(isOskEnterEvent({ which: 13 }), true);
  assert.equal(isOskEnterEvent({ key: "a", keyCode: 65 }), false);
  assert.equal(isOskEnterEvent(null), false);
});

check("keyboard visibility reads either platform object", () => {
  assert.equal(systemKeyboardVisible({ webOSSystem: { isKeyboardVisible: true } }), true);
  assert.equal(systemKeyboardVisible({ PalmSystem: { isKeyboardVisible: false } }), false);
  // Some firmwares expose it as a method.
  assert.equal(
    systemKeyboardVisible({ webOSSystem: { isKeyboardVisible: () => true } }),
    true,
  );
  // Neither present: null, so a caller can tell "no" from "cannot know".
  assert.equal(systemKeyboardVisible({}), null);
});

check("the state event is read from whichever shape the firmware sends", () => {
  assert.equal(KEYBOARD_STATE_EVENT, "keyboardStateChange");
  assert.equal(keyboardVisibleFromEvent({ detail: { visibility: true } }, {}), true);
  assert.equal(keyboardVisibleFromEvent({ detail: { visibility: false } }, {}), false);
  assert.equal(keyboardVisibleFromEvent({ detail: { state: "visible" } }, {}), true);
  assert.equal(keyboardVisibleFromEvent({ detail: { state: "hidden" } }, {}), false);
  // No usable payload → fall back to the property.
  assert.equal(
    keyboardVisibleFromEvent({}, { webOSSystem: { isKeyboardVisible: true } }),
    true,
  );
  // No payload and no platform → treated as not visible, so a desktop dev
  // build never suppresses its resizes forever.
  assert.equal(keyboardVisibleFromEvent({}, {}), false);
});

if (failures) {
  console.error(`${failures} osk-input test(s) failed`);
  process.exit(1);
}
console.log("osk-input tests passed");
