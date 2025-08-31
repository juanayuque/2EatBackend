"use strict";

function deg2rad(d) { return d * Math.PI / 180; }
function haversineKm(a, b) {
  const R = 6371;
  const dLat = deg2rad((b.lat || 0) - (a.lat || 0));
  const dLng = deg2rad((b.lng || 0) - (a.lng || 0));
  const s1 = Math.sin(dLat/2), s2 = Math.sin(dLng/2);
  const aa = s1*s1 + Math.cos(deg2rad(a.lat||0))*Math.cos(deg2rad(b.lat||0))*s2*s2;
  return 2 * R * Math.asin(Math.sqrt(aa));
}
const asFloat = (dec) => (dec == null ? null : Number(dec));
const norm = (s) => String(s || "").toLowerCase().replace(/[_\s-]+/g, " ").trim();

const CUISINE_KEYWORDS = {
  indian: ["indian"],
  chinese: ["chinese", "szechuan", "sichuan", "cantonese", "hunan"],
  italian: ["italian", "pizza", "pasta", "sicilian", "tuscan"],
  japanese: ["japanese", "sushi", "ramen", "izakaya"],
  thai: ["thai"],
  mexican: ["mexican", "taqueria", "taco"],
  korean: ["korean", "bbq"],
  american: ["american", "burger", "bbq", "diner"],
  vietnamese: ["vietnamese", "pho", "banh mi", "bahn mi"],
  mediterranean: ["mediterranean", "greek", "turkish", "lebanese"],
  "middle eastern": ["middle eastern", "lebanese", "turkish", "persian", "iranian"],
  spanish: ["spanish", "tapas"],
  french: ["french", "brasserie"],
  greek: ["greek"],
  turkish: ["turkish"],
  lebanese: ["lebanese"],
  persian: ["persian", "iranian"],
  "fast food": ["fast"],
  fastfood: ["fast"],
};

function expandUserCuisineKeywords(prefs) {
  const set = new Set();
  for (const p of prefs || []) {
    const key = norm(p);
    const arr = CUISINE_KEYWORDS[key] || [key];
    arr.forEach((a) => set.add(a));
  }
  return Array.from(set);
}

function labelOfUser(u) {
  const dn = u?.displayName?.trim();
  if (dn) return dn;
  const un = u?.username?.trim();
  if (un) return un;
  const email = u?.email || "";
  if (email.includes("@")) return email.split("@")[0];
  return "Friend";
}
const usernameOfUser = (u) => u?.username || null;

module.exports = {
  deg2rad,
  haversineKm,
  asFloat,
  norm,
  CUISINE_KEYWORDS,
  expandUserCuisineKeywords,
  labelOfUser,
  usernameOfUser,
};
