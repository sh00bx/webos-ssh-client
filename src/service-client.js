// Typed surface over the Luna bridge for our own background service. Every
// call the frontend makes to com.pwntastic.sshclient.service goes through
// here; no other module builds service URIs or raw luna payloads.
import { lunaCall, lunaSubscribe } from "./luna.js";
import { SERVICE } from "./service-uri.js";

export { SERVICE };

export function serviceCall(method, parameters = {}) {
  return new Promise((resolve, reject) => {
    lunaCall(
      SERVICE,
      method,
      parameters,
      (resp) => {
        if (resp && resp.returnValue === false) {
          reject(resp);
          return;
        }
        resolve(resp || {});
      },
      (err) => reject(err),
    );
  });
}

// Fire-and-forget call with an optional reply inspector. The hot write/resize
// path uses this deliberately instead of serviceCall: one promise chain per
// keystroke would be pure overhead, and an unhandled rejection per keystroke
// on a flaky bridge would be a genuine regression. The reply callback exists
// solely so the caller can watch for NO_SESSION (service restarted).
export function serviceSend(method, parameters, onReply, onError) {
  lunaCall(SERVICE, method, parameters, onReply, onError);
}

export function subscribeSession(method, payload, onMessage, onError) {
  return lunaSubscribe(SERVICE, method, payload, onMessage, onError);
}

export function subscribeBackdrop(onMessage, onError) {
  return lunaSubscribe(
    SERVICE,
    "backdrop/watch",
    { subscribe: true },
    onMessage,
    onError,
  );
}

export function listSessions() {
  return serviceCall("sessions/list").then((resp) => resp.sessions || []);
}

// Is the local-shell helper (ptyd) reachable? Answers rather than throws: the
// connect form asks this on every mount to decide whether to offer the button
// at all, and a TV without the helper installed is the normal case, not an
// error worth a rejected promise on every login screen.
export function localShellAvailable() {
  return serviceCall("local/status")
    .then((resp) => ({
      available: Boolean(resp && resp.available),
      errorText: (resp && resp.errorText) || null,
    }))
    .catch(() => ({ available: false, errorText: null }));
}

export function compactError(err) {
  if (!err) return null;
  return {
    errorCode: err.errorCode || err.code || null,
    errorText: err.errorText || err.message || String(err),
  };
}
