// Promise wrappers for the keys/* Luna methods. serviceCall rejects on
// returnValue:false — on this app's bridge path (PalmServiceBridge, no
// webOSTV.js) an error body arrives through the SUCCESS callback, and
// resolving it regardless used to make a failing service look like an empty
// key store ("No keys yet."), which reads as "the update wiped my keys".
import { serviceCall } from "./service-client.js";

export function listKeys() {
  return serviceCall("keys/list", {}).then((resp) => resp.keys || []);
}

export function addKey({ label, privateKeyPem, passphrase }) {
  return serviceCall("keys/add", { label, privateKeyPem, passphrase });
}

export function removeKey(id) {
  return serviceCall("keys/remove", { id });
}

// Pinned host keys (TOFU store). hosts is a map "host:port" -> { fingerprint,
// addedAt }.
export function listKnownHosts() {
  return serviceCall("knownhosts/list", {}).then((resp) => resp.hosts || {});
}

export function removeKnownHost(host, port) {
  return serviceCall("knownhosts/remove", { host, port });
}
