// src/recs/pool.js
//
// Build a "preferred" pool near a lat/lng for ONE user.
// No session reads/writes here. Safe to use from solo or group flows.

const { haversineKm, asFloat } = require("../utils/geo");

// crude mapping so "Chinese" matches Google place types like "chinese_restaurant"
const CUISINE_KEYWORDS = {
  indian: ["indian"],
  chinese: ["chinese", "szechuan", "sichuan", "cantonese", "hunan", "hotpot", "noodle",],
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

function normalizeCuisine(c) {
  return String(c || "").trim().toLowerCase();
}

function typeMatchesCuisine(types = [], cuisine) {
  const t = (types || []).map((x) => String(x).toLowerCase());
  const key = normalizeCuisine(cuisine);
  const aliases = CUISINE_ALIASES[key] || [key];
  return aliases.some((a) => t.some((ty) => ty.includes(a)));
}

// VERY rough price mapping: if user budgets are low, prefer cheaper priceLevels
function eligibleByBudget(priceLevel, budgetMax) {
  if (budgetMax == null) return true;
  // tweak as you like
  if (budgetMax <= 15) return (priceLevel ?? 2) <= 1;
  if (budgetMax <= 25) return (priceLevel ?? 2) <= 2;
  if (budgetMax <= 40) return (priceLevel ?? 2) <= 3;
  return true;
}

async function ensurePreferredPool({
  places,          // created via createPlacesService({ prisma, googleApiKey })
  lat,
  lng,
  user,
  desiredMin = 20, // aim for at least this many
}) {
  const prisma = places?.prisma;
  if (!prisma) throw new Error("ensurePreferredPool: places.prisma missing");

  const radiusKm = Number(user?.searchDistance ?? 5);
  const widenKm = Math.max(radiusKm, 3); // give ourselves some headroom

  // 1) Pull a chunk from DB (cheap), then filter/sort in JS.
  const rows = await prisma.restaurant.findMany({
    select: {
      id: true,
      name: true,
      latitude: true,
      longitude: true,
      types: true,
      priceLevel: true,
      servesVegetarianFood: true,
      allowsDogs: true,
    },
    take: 800, // adjust based on DB size
    orderBy: { createdAt: "desc" },
  });

  const withDist = rows
    .map((r) => ({
      ...r,
      _dist: haversineKm(
        { lat, lng },
        { lat: asFloat(r.latitude), lng: asFloat(r.longitude) }
      ),
    }))
    .filter((r) => r._dist <= widenKm);

  // 2) Preference filters
  const prefCuisines = Array.isArray(user?.preferredCuisines) ? user.preferredCuisines : [];
  const wantsVeg = (user?.dietaryNeeds || []).some((d) =>
    String(d).toLowerCase().includes("veget")
  );

  let filtered = withDist.filter((r) => eligibleByBudget(r.priceLevel, user?.budgetMax));
  if (wantsVeg) filtered = filtered.filter((r) => r.servesVegetarianFood === true);

  if (prefCuisines.length) {
    const want = prefCuisines.map(normalizeCuisine);
    const keep = new Set();
    for (const r of filtered) {
      if (want.some((c) => typeMatchesCuisine(r.types, c))) keep.add(r.id);
    }
    // If nothing matched cuisines, fall back to distance-only (so we still return something)
    if (keep.size) filtered = filtered.filter((r) => keep.has(r.id));
  }

  // 3) Sort (distance first), then truncate
  filtered.sort((a, b) => a._dist - b._dist);
  const base = filtered.slice(0, Math.max(desiredMin * 2, desiredMin));

  // 4) Hydrate to a consistent minimal shape expected by callers (id, name, …)
  return base.map((r) => ({
    id: r.id,
    name: r.name,
    latitude: r.latitude,
    longitude: r.longitude,
    types: r.types,
    priceLevel: r.priceLevel,
  }));
}

module.exports = {
  ensurePreferredPool,
};
