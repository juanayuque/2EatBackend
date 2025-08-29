// src/recs/pagination.js

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mkSeed(sessionId) {
  // stable but "random enough" per session
  return hashStr("seed:" + sessionId);
}

function orderPoolDeterministic(pool, sessionId, seed) {
  const keySeed = seed ?? mkSeed(sessionId);
  return pool
    .slice()
    .sort(
      (a, b) =>
        (hashStr(keySeed + ":" + a.id) % 100000) - (hashStr(keySeed + ":" + b.id) % 100000)
    );
}

// Safe no-DB cursor; encodes index + seed + lat/lng so /next doesn't need lat/lng
function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}
function decodeCursor(s) {
  try {
    return JSON.parse(Buffer.from(String(s), "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

module.exports = {
  hashStr,
  mkSeed,
  orderPoolDeterministic,
  encodeCursor,
  decodeCursor,
};
