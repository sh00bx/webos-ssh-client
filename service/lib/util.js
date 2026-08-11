const crypto = require("crypto");

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function genId() {
  return crypto.randomBytes(8).toString("hex");
}

function safeRespond(message, body) {
  try {
    message.respond(body);
  } catch (e) {
    /* subscription gone */
  }
}

function getMessageToken(message) {
  if (!message) return null;
  return message.uniqueToken || message.token || null;
}

module.exports = { clampInt, genId, safeRespond, getMessageToken };
