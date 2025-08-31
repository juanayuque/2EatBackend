// src/group/pool.js
// DB-only group pool builder (no Places service, no src/recs/pool usage)

const { haversineKm, asFloat } = require("../utils/geo");

const CACHE = new Map(); // sessionId -> { items, key, at }

/** cuisine keywords (very rough matching against Google place 'types') */
const CUISINE_KEYWORDS = {
  indian: ["indian"],
  chinese: ["chinese", "szechuan", "sichuan", "cantonese", "hunan", "hotpot", "noodle"],
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

const norm = (s) => String(s || "").trim().toLowerCase();

function expandCuisineKeywords(list) {
  const out = [];
  for (const c of list || []) {
    const key = norm(c);
    const kws = CUISINE_KEYWORDS[key] || [key];
    out.push(...kws);
  }
  return Array.from(new Set(out));
}

function typeMatchesKeywords(types = [], keywords = []) {
  if (!keywords.length) return true; // if none provided, don't restrict by cuisine
  const t = (types || []).map((x) => String(x).toLowerCase());
  return keywords.some((kw) => t.some((ty) => ty.includes(kw)));
}

function eligibleByBudget(priceLevel, budgetMax) {
  if (budgetMax == null) return true;
  if (budgetMax <= 15) return (priceLevel ?? 2) <= 1;
  if (budgetMax <= 25) return (priceLevel ?? 2) <= 2;
  if (budgetMax <= 40) return (priceLevel ?? 2) <= 3;
  return true;
}

function requirementsFromUser(user) {
  const needs = (user?.dietaryNeeds || []).map(norm);
  const vegetarian = needs.some((d) => d.includes("veget"));
  // You can extend these if you model pet/parking as user prefs later
  return { vegetarian, petFriendly: false, parking: false };
}

function baseRadiusKmFromPrefs(aPrefs, bPrefs) {
  const a = Number(aPrefs?.distance ?? 5);
  const b = Number(bPrefs?.distance ?? 5);
  const minBoth = Math.min(Number.isFinite(a) ? a : 5, Number.isFinite(b) ? b : 5);
  return Math.max(minBoth, 5);
}

/**
 * Build a DB-only pool for a single anchor (loc + prefs).
 */
async function buildForUser({ prisma, lat, lng, prefs, want = 12, baseRadiusKm = 10, fromTag = "A", log = () => {} }) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];

  log?.(`[pool] user=${fromTag} lat=${lat} lng=${lng} baseRadiusKm=${baseRadiusKm} desiredMin=${want}`);

  const reqRaw = requirementsFromUser({ dietaryNeeds: prefs?.dietaryNeeds || [] });
  log?.("[pool] requirements(raw)= ", reqRaw);

  // We only filter vegetarian at DB-level (if field exists as boolean); pet/parking are computed client-side
  const applyDB = [];
  if (reqRaw.vegetarian) applyDB.push("servesVegetarianFood=true");
  log?.("[pool] requirements(DB filter applied)= ", applyDB.length ? applyDB.join(", ") : "(none)");

  const prefCuisines = Array.isArray(prefs?.preferredCuisines) ? prefs.preferredCuisines : [];
  log?.("[pool] preferredCuisines(raw)= ", prefCuisines);
  const cuisineKeywords = expandCuisineKeywords(prefCuisines);
  log?.("[pool] preferredCuisines(expanded keywords)= ", cuisineKeywords);

  const plan = [baseRadiusKm, 10, 20, 30, 50]; // expand outward as needed
  log?.("[pool] radius expansion plan (km)= ", plan);

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
      parkingOptions: true,
      createdAt: true,
    },
    take: 1200,
    orderBy: { createdAt: "desc" },
  });

  // compute dist + primary filters
  let best = [];
  for (let i = 0; i < plan.length; i++) {
    const radiusKm = plan[i];
    const within = rows
      .map((r) => ({
        ...r,
        _dist: haversineKm(
          { lat, lng },
          { lat: asFloat(r.latitude), lng: asFloat(r.longitude) }
        ),
      }))
      .filter((r) => r._dist <= radiusKm)
      .filter((r) => eligibleByBudget(r.priceLevel, prefs?.budgetMax));

    // vegetarian (strict if requested)
    const afterReq = reqRaw.vegetarian ? within.filter((r) => r.servesVegetarianFood === true) : within;

    // cuisine match (if any keywords)
    let afterCuisine = afterReq;
    if (cuisineKeywords.length) {
      afterCuisine = afterReq.filter((r) => typeMatchesKeywords(r.types, cuisineKeywords));
      if (!afterCuisine.length) {
        log?.("[pool] (STRICT) skipped: no cuisine keywords match; trying FLEX without cuisine");
        afterCuisine = afterReq; // flex fallback if too strict
      } else {
        log?.(`[pool] (STRICT) ---- radiusKm=${radiusKm}km ----`);
      }
    } else {
      log?.("[pool] (STRICT) skipped: no cuisine keywords");
      log?.(`[pool] (FLEX) ---- radiusKm=${radiusKm}km ----`);
    }

    // order by distance asc
    afterCuisine.sort((a, b) => a._dist - b._dist);

    best = afterCuisine.slice(0, Math.max(want * 2, want));
    if (best.length >= want) break; // good enough
  }

  // shape
  return best.map((r) => ({
    id: r.id,
    name: r.name,
    latitude: r.latitude,
    longitude: r.longitude,
    types: r.types,
    priceLevel: r.priceLevel,
    from: fromTag,
  }));
}

/**
 * Interleave two arrays A/B and dedupe by id (keep first occurrence, prefer A).
 */
function combineAB(aList, bList) {
  const out = [];
  const seen = new Set();
  const maxLen = Math.max(aList.length, bList.length);
  for (let i = 0; i < maxLen; i++) {
    const ai = aList[i];
    if (ai && !seen.has(ai.id)) {
      out.push(ai);
      seen.add(ai.id);
    }
    const bi = bList[i];
    if (bi && !seen.has(bi.id)) {
      out.push(bi);
      seen.add(bi.id);
    }
  }
  return out;
}

/**
 * Build the combined group pool (DB only), cache by sessionId + inputs key.
 */
async function buildGroupPool({
  prisma,
  sessionId,
  aUser, // { id, prefs, tag: "A" }
  bUser, // { id, prefs, tag: "B" }
  locA,  // { lat, lng } | null
  locB,  // { lat, lng } | null
  want = 12,
  log = () => {},
}) {
  const baseRadiusKm = baseRadiusKmFromPrefs(aUser?.prefs, bUser?.prefs);
  const make = async () => {
    const aList = locA
      ? await buildForUser({
          prisma,
          lat: locA.lat,
          lng: locA.lng,
          prefs: aUser?.prefs || {},
          want,
          baseRadiusKm,
          fromTag: "A",
          log,
        })
      : [];
    const bList = locB
      ? await buildForUser({
          prisma,
          lat: locB.lat,
          lng: locB.lng,
          prefs: bUser?.prefs || {},
          want,
          baseRadiusKm,
          fromTag: "B",
          log,
        })
      : [];

    const combined = combineAB(aList, bList);
    log?.("[pool] combined counts A/B/total = ", aList.length, bList.length, combined.length);

    return combined.slice(0, Math.max(want * 2, want)); // keep a bit extra
  };

  const items = await make();
  return { sessionId, items };
}

/**
 * Simple memo: invalidate when locA/locB/prefs change via a key hash.
 */
function mkKey({ aUser, bUser, locA, locB, want }) {
  return JSON.stringify({
    a: { id: aUser?.id, prefs: aUser?.prefs },
    b: { id: bUser?.id, prefs: bUser?.prefs },
    locA,
    locB,
    want,
  });
}

async function getOrBuildSessionPool({ sessionId, prisma, aUser, bUser, locA, locB, want = 12, log = () => {} }) {
  if (!sessionId) throw new Error("sessionId required");
  const key = mkKey({ aUser, bUser, locA, locB, want });
  const cached = CACHE.get(sessionId);
  if (cached && cached.key === key) {
    log?.("[pool] cache-hit", { sessionId, poolCount: cached.items.length });
    return { sessionId, items: cached.items };
  }

  const built = await buildGroupPool({ prisma, sessionId, aUser, bUser, locA, locB, want, log });
  CACHE.set(sessionId, { items: built.items, key, at: Date.now() });
  log?.("[pool] cache-store", { sessionId, poolCount: built.items.length });
  return built;
}

function clearPool(sessionId) {
  CACHE.delete(sessionId);
}

module.exports = {
  getOrBuildSessionPool,
  buildGroupPool,
  clearPool,
};
