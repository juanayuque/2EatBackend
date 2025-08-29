// Explains *why*: keeping math helpers isolated avoids circular deps and eases unit tests.
const toRad = (x) => (x * Math.PI) / 180;

function haversineKm(a, b) {
  const R = 6371;
  const dLat = toRad(Number(b.lat) - Number(a.lat));
  const dLon = toRad(Number(b.lng) - Number(a.lng));
  const sLat1 = toRad(Number(a.lat));
  const sLat2 = toRad(Number(b.lat));
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(sLat1) * Math.cos(sLat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

const distanceBand = (km) => (km <= 1 ? "near" : km <= 5 ? "mid" : "far");
const asFloat = (v) => parseFloat(String(v));

module.exports = { haversineKm, distanceBand, asFloat };
