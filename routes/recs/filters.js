// src/recs/filters.js
const { haversineKm, distanceBand, asFloat } = require("../utils/geo");

// --- Normalizers -------------------------------------------------

const norm = (s) => String(s || "").toLowerCase().replace(/[_\s-]+/g, " ").trim();
const lc = (s) => String(s || "").toLowerCase();

function textIncludesAny(r, needles) {
  const fields = [
    (r.name || "").toLowerCase(),
    (r.primaryTypeDisplayName || "").toLowerCase(),
    (r.editorialSummary || "").toLowerCase(),
    (r.editorial_summary || "").toLowerCase(),
  ].filter(Boolean);

  return needles.some((n) => fields.some((f) => f.includes(n)));
}

// --- User preferences to filter tokens ---------------------------

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
  french: ["french", "bistro", "brasserie"],
  greek: ["greek"],
  turkish: ["turkish"],
  lebanese: ["lebanese"],
  persian: ["persian", "iranian"],
  "fast food": ["fast"],
  fastfood: ["fast"],
};

function cuisineKeywordsFromUser(user) {
  const out = new Set();
  for (const p of user?.preferredCuisines || []) {
    const key = norm(p);
    (CUISINE_KEYWORDS[key] || [key]).forEach((k) => out.add(k));
  }
  return out;
}

function requirementsFromUser(user) {
  const needs = new Set((user?.dietaryNeeds || []).map((x) => norm(x)));
  return {
    vegetarian: needs.has("vegetarian"),
    petFriendly: needs.has("pet friendly"),
    parking: needs.has("parking"),
  };
}

function priceBandFromBudget(budgetMax) {
  if (budgetMax == null) return 0;
  if (budgetMax <= 15) return 1;
  if (budgetMax <= 30) return 2;
  if (budgetMax <= 60) return 3;
  return 4;
}

function radiusFromUser(user) {
  if (user?.searchDistance === null) return 50;
  if (typeof user?.searchDistance === "number" && user.searchDistance > 0) return user.searchDistance;
  return 15;
}

// --- Restaurant checks (FIXED/robust) ----------------------------

function hasAnyParking(r) {
  // support both DB structure and precomputed boolean
  const flag = r.hasParking === true;
  const options =
    r.parkingOptions && typeof r.parkingOptions === "object"
      ? Object.values(r.parkingOptions).some(Boolean)
      : false;
  const byText = textIncludesAny(r, ["parking", "car park", "parking lot"]);
  return flag || options || byText;
}

function isPetFriendly(r) {
  const flag = r.allowsDogs === true;
  const byText = textIncludesAny(r, ["dog friendly", "pet friendly", "dogs welcome"]);
  return flag || byText;
}

function isVegetarianFriendly(r) {
  const flag = r.servesVegetarianFood === true;
  const hasType =
    Array.isArray(r.types) &&
    r.types.map((t) => String(t).toLowerCase()).includes("vegetarian_restaurant");
  const byText = textIncludesAny(r, ["vegetarian", "vegan", "veg-friendly"]);
  return flag || hasType || byText;
}

function restaurantMeetsRequirements(r, req) {
  if (!req) return true;
  if (req.vegetarian && !isVegetarianFriendly(r)) return false;
  if (req.petFriendly && !isPetFriendly(r)) return false;
  if (req.parking && !hasAnyParking(r)) return false;
  return true;
}

function restaurantMatchesCuisine(r, keywordSet) {
  if (!keywordSet || !keywordSet.size) return true;
  const primary = (r.primaryType || "").toLowerCase();            // like "italian_restaurant"
  const types = Array.isArray(r.types) ? r.types.map((t) => String(t).toLowerCase()) : [];
  const searchableText = [r.name, r.primaryTypeDisplayName, r.editorialSummary]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  for (const k of keywordSet) {
    const underscore = k.replace(/\s+/g, "_");
    if (primary.includes(underscore)) return true;
    if (types.some((t) => t.includes(underscore))) return true;
    if (searchableText.includes(k)) return true;
  }
  return false;
}

// --- Main filter+prioritize --------------------------------------

function filterAndPrioritizeByPreferences(pool, user, lat, lng, desiredMin = 60, radiusKm = 15) {
  const keys = cuisineKeywordsFromUser(user);
  const req = requirementsFromUser(user);

  const here = { lat, lng };
  const withDist = pool.map((r) => ({
    r,
    d: haversineKm(here, { lat: asFloat(r.latitude), lng: asFloat(r.longitude) }),
  }));

  const within = Number.isFinite(radiusKm) ? withDist.filter((x) => x.d <= radiusKm) : withDist;

  const baseRows = within.filter(({ r }) => restaurantMeetsRequirements(r, req));

  const cuisineFirst = baseRows
    .filter(({ r }) => restaurantMatchesCuisine(r, keys))
    .sort((a, b) => a.d - b.d)
    .map((x) => x.r);

  const nearestFill = baseRows
    .sort((a, b) => a.d - b.d)
    .map((x) => x.r)
    .filter((r) => !cuisineFirst.includes(r));

  const merged = [...cuisineFirst, ...nearestFill].slice(0, Math.max(desiredMin, 1));
  return merged;
}

module.exports = {
  norm,
  lc,
  textIncludesAny,

  cuisineKeywordsFromUser,
  requirementsFromUser,
  priceBandFromBudget,
  radiusFromUser,

  hasAnyParking,
  isPetFriendly,
  isVegetarianFriendly,
  restaurantMeetsRequirements,
  restaurantMatchesCuisine,

  filterAndPrioritizeByPreferences,
};
