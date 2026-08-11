// Thin wrapper around webOS.service.request. When running outside webOS
// (e.g. a desktop browser used for layout work), the bridge is missing and
// calls log to the console instead of throwing.

function getBridge() {
  if (typeof webOS !== "undefined" && webOS.service && webOS.service.request) {
    return webOS.service.request.bind(webOS.service);
  }
  return null;
}

function getPalmServiceBridge() {
  if (
    typeof PalmServiceBridge !== "undefined" &&
    typeof PalmServiceBridge === "function"
  ) {
    return PalmServiceBridge;
  }
  return null;
}

function methodUri(uri, method) {
  return `${String(uri).replace(/\/+$/, "")}/${String(method).replace(/^\/+/, "")}`;
}

function parsePalmResponse(raw) {
  if (typeof raw !== "string") return raw;
  return JSON.parse(raw);
}

function withSubscription(parameters) {
  const payload = {};
  const source = parameters || {};
  Object.keys(source).forEach((key) => {
    payload[key] = source[key];
  });
  payload.subscribe = true;
  return payload;
}

function bridgeUnavailable(onFailure) {
  const err = {
    returnValue: false,
    errorCode: "BRIDGE_UNAVAILABLE",
    errorText: "webOS Luna bridge unavailable",
  };
  if (onFailure) setTimeout(() => onFailure(err), 0);
}

export function lunaCall(uri, method, parameters, onSuccess, onFailure) {
  const bridge = getBridge();
  if (!bridge) {
    const PalmBridge = getPalmServiceBridge();
    if (!PalmBridge) {
      console.warn("[luna] no bridge — would call", uri, method, parameters);
      bridgeUnavailable(onFailure);
      return null;
    }

    const palmBridge = new PalmBridge();
    palmBridge.onservicecallback = (raw) => {
      try {
        onSuccess && onSuccess(parsePalmResponse(raw));
      } catch (e) {
        onFailure && onFailure({
          returnValue: false,
          errorCode: "BAD_BRIDGE_RESPONSE",
          errorText: e.message || String(e),
        });
      }
    };

    try {
      palmBridge.call(methodUri(uri, method), JSON.stringify(parameters || {}));
    } catch (e) {
      onFailure && onFailure({
        returnValue: false,
        errorCode: "BRIDGE_CALL_FAILED",
        errorText: e.message || String(e),
      });
    }
    return palmBridge;
  }
  return bridge(uri, {
    method,
    parameters: parameters || {},
    onSuccess: (resp) => onSuccess && onSuccess(resp),
    onFailure: (err) => onFailure && onFailure(err),
  });
}

export function lunaSubscribe(uri, method, parameters, onMessage, onError) {
  const bridge = getBridge();
  if (!bridge) {
    const PalmBridge = getPalmServiceBridge();
    if (!PalmBridge) {
      console.warn("[luna] no bridge — would subscribe", uri, method, parameters);
      bridgeUnavailable(onError);
      return { cancel() {} };
    }

    const palmBridge = new PalmBridge();
    palmBridge.onservicecallback = (raw) => {
      try {
        onMessage && onMessage(parsePalmResponse(raw));
      } catch (e) {
        onError && onError({
          returnValue: false,
          errorCode: "BAD_BRIDGE_RESPONSE",
          errorText: e.message || String(e),
        });
      }
    };

    try {
      palmBridge.call(
        methodUri(uri, method),
        JSON.stringify(withSubscription(parameters)),
      );
    } catch (e) {
      onError && onError({
        returnValue: false,
        errorCode: "BRIDGE_CALL_FAILED",
        errorText: e.message || String(e),
      });
    }

    return {
      cancel() {
        if (typeof palmBridge.cancel === "function") palmBridge.cancel();
      },
    };
  }
  return bridge(uri, {
    method,
    parameters: parameters || {},
    subscribe: true,
    onSuccess: (resp) => onMessage && onMessage(resp),
    onFailure: (err) => onError && onError(err),
  });
}
