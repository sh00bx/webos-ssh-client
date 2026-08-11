// The single Service instance and the caller gate. EVERY method registration
// must go through register() below — a direct service.register() call would
// silently drop the gate for that method and let any sideloaded app read keys
// or write into a session. Mechanical check:
//   grep -rn "service.register(" service/ | grep -v lib/bus.js   → must be empty
//
// `webos-service` is provided by the webOS platform at runtime, not via npm.
// Do not add it to package.json — the IPK is loaded by the device's platform
// Node, which exposes `webos-service` from a system path.
const Service = require("webos-service");
const { CALLER_ID_PREFIX } = require("./config");
const { safeRespond } = require("./util");
const { debugLog } = require("./debug-log");

const service = new Service("com.pwntastic.sshclient.service");

// Who is calling. An app carries an application id (LSMessageGetApplicationID),
// a service carries a service name, and the two arrive in different fields —
// until 0.8.2 only the first was consulted, so a sideloaded *service*, which
// has no application id at all, fell into the "no identity" case below and was
// waved through. Our own app is unaffected either way: its calls come from the
// web app and carry the application id.
function callerIdentity(message) {
  if (!message) return "";
  return String(message.sender || message.senderServiceName || "");
}

// This is a soft gate on a rooted TV (luna-send -a can spoof any id, and root
// can read the keystore off the filesystem without asking us at all), but it
// stops other sideloaded apps and services from silently reading keys or
// writing into sessions. A caller with no identity whatsoever is still allowed:
// see the caller_seen log below — flipping that to a denial needs evidence from
// a real device that nothing legitimate arrives that way.
function callerAllowed(message) {
  const name = callerIdentity(message);
  if (!name) return true;
  // luna-send registers as com.webos.lunasend-<pid> on this firmware; only
  // root / developer mode can run it, so it stays allowed for debugging
  // (and for the knownhosts/remove recovery path).
  if (name.indexOf("com.webos.lunasend-") === 0) return true;
  return (
    name === CALLER_ID_PREFIX || name.indexOf(CALLER_ID_PREFIX + ".") === 0
  );
}

// One line per distinct caller identity, so "who actually calls this service"
// is answerable from a device log instead of by reasoning about the platform.
// The anonymous case in particular is what stands between the gate above and a
// hard deny-by-default. Capped: an identity is caller-controlled input, and an
// unbounded set of them is a slow memory leak with a spoofer at the other end.
const seenCallers = new Set();

function noteCaller(method, message) {
  const id = callerIdentity(message) || "(anonymous)";
  if (seenCallers.has(id) || seenCallers.size >= 20) return;
  seenCallers.add(id);
  debugLog("caller_seen", { method, caller: id });
}

function register(name, requestHandler, cancelHandler) {
  service.register(
    name,
    (message) => {
      noteCaller(name, message);
      if (!callerAllowed(message)) {
        debugLog("caller_denied", {
          method: name,
          sender: callerIdentity(message),
        });
        return safeRespond(message, {
          returnValue: false,
          errorCode: "CALLER_DENIED",
          errorText: "caller not permitted",
        });
      }
      return requestHandler(message);
    },
    cancelHandler,
  );
}

module.exports = { service, register };
