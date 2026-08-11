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

// webos-service sets message.sender to the caller's application id (via
// LSMessageGetApplicationID) or service name; anonymous shell luna-send has
// neither. This is a soft gate on a rooted TV (luna-send -a can spoof), but
// it stops other sideloaded apps/services from silently reading keys or
// writing into sessions.
function callerAllowed(message) {
  const sender = message && message.sender;
  if (!sender) return true;
  const name = String(sender);
  // luna-send registers as com.webos.lunasend-<pid> on this firmware; only
  // root / developer mode can run it, so it stays allowed for debugging
  // (and for the knownhosts/remove recovery path).
  if (name.indexOf("com.webos.lunasend-") === 0) return true;
  return (
    name === CALLER_ID_PREFIX || name.indexOf(CALLER_ID_PREFIX + ".") === 0
  );
}

function register(name, requestHandler, cancelHandler) {
  service.register(
    name,
    (message) => {
      if (!callerAllowed(message)) {
        debugLog("caller_denied", {
          method: name,
          sender: message && message.sender,
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
