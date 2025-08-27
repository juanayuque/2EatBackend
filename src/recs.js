// src/services/recs.js
const RECS_URL = process.env.RECS_URL || "http://127.0.0.1:8000";
const RECS_TIMEOUT_MS = Number(process.env.RECS_TIMEOUT_MS || 2500);

async function _post(path, body) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), RECS_TIMEOUT_MS);

  try {
    const res = await fetch(`${RECS_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`recs ${path} ${res.status}: ${txt}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

async function health() {
  const res = await fetch(`${RECS_URL}/health`);
  return res.ok;
}

// shape your payload here however your FastAPI expects it
async function rank({ userId, items, userFeatures, k = 100 }) {
  return _post("/rank", { user_id: userId, items, user_features: userFeatures, k });
}

module.exports = { health, rank };
