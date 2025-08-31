"use strict";

const prisma = require("../prisma");
const { haversineKm, expandUserCuisineKeywords } = require("./utils.js");

const RADIUS_KM_DEFAULT = Number(process.env.GROUP_RADIUS_KM || 5);

const log = (tag, obj) => {
  try { console.log(`[group] ${tag}`, JSON.stringify(obj, null, 2)); }
  catch { console.log(`[group] ${tag}`, obj); }
};

async function fetchUserPrefs(userId) {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, displayName: true, username: true, email: true,
      searchDistance: true, budgetMax: true, dietaryNeeds: true, preferredCuisines: true,
    },
  });
  return {
    id: u?.id,
    name: u ? (u.displayName || u.username || (u.email?.split("@")[0]) || "Friend") : "Friend",
    prefs: {
      distance: (typeof u?.searchDistance === "number" ? u.searchDistance : null),
      budgetMax: (typeof u?.budgetMax === "number" ? u.budgetMax : null),
      dietaryNeeds: Array.isArray(u?.dietaryNeeds) ? u.dietaryNeeds : [],
      preferredCuisines: Array.isArray(u?.preferredCuisines) ? u.preferredCuisines : [],
    },
  };
}

function cuisineMatches(r, needles) {
  if (!needles?.length) return true;
  const summary = String(r.editorialSummary || "").toLowerCase();
  const primary = String(r.primaryType || "").toLowerCase();
  const primaryDN = String(r.primaryTypeDisplayName || "").toLowerCase();
  const types = Array.isArray(r.types) ? r.types.map((t) => String(t).toLowerCase().replace(/_/g, " ")) : [];
  const name = String(r.name || "").toLowerCase();
  for (const k of needles) {
    if (summary.includes(k) || primary.includes(k) || primaryDN.includes(k) || name.includes(k)) return true;
    if (types.some((t) => t.includes(k))) return true;
  }
  return false;
}

async function fetchForUserAt({ user, loc, want, radiusKm }) {
  if (!loc) return [];
  const dLat = radiusKm / 111;
  const dLng = radiusKm / (111 * Math.cos((loc.lat || 0) * Math.PI / 180));
  const where = {
    latitude: { gte: (loc.lat - dLat), lte: (loc.lat + dLat) },
    longitude: { gte: (loc.lng - dLng), lte: (loc.lng + dLng) },
  };
  if (user.prefs?.budgetMax != null) where.priceLevel = { lte: user.prefs.budgetMax };

  const rows = await prisma.restaurant.findMany({
    where,
    select: {
      id: true, name: true, latitude: true, longitude: true,
      formattedAddress: true, priceLevel: true,
      primaryType: true, primaryTypeDisplayName: true, types: true,
      editorialSummary: true,
    },
    take: 200,
  });

  const needles = expandUserCuisineKeywords(user.prefs?.preferredCuisines || []);
  const maxDist = (user.prefs?.distance ?? radiusKm) || radiusKm;

  const filtered = rows
    .map((r) => {
      const rLat = Number(r.latitude); const rLng = Number(r.longitude);
      const dist = haversineKm({ lat: rLat, lng: rLng }, loc);
      return { ...r, _dist: dist };
    })
    .filter((r) => r._dist <= maxDist)
    .filter((r) => cuisineMatches(r, needles));

  filtered.sort((a, b) => a._dist - b._dist);
  return filtered.slice(0, want).map((r) => ({ id: r.id, name: r.name, from: user.tag || "?" }));
}

function sig(ctx, wantEach, radiusKm) {
  const round = (n) => (typeof n === "number" ? Math.round(n * 1e6) / 1e6 : null);
  const a = ctx?.locA ? { lat: round(ctx.locA.lat), lng: round(ctx.locA.lng) } : null;
  const b = ctx?.locB ? { lat: round(ctx.locB.lat), lng: round(ctx.locB.lng) } : null;
  return JSON.stringify({ a, b, wantEach, radiusKm });
}

/**
 * Returns { poolIds, metaById }
 * Rebuilds when:
 *  - no pool yet
 *  - meta missing or incomplete
 *  - locA/locB changed since last build (compared via ctx.poolSig)
 */
async function getOrBuildSessionPool({ session, wantEach = 10, radiusKm = RADIUS_KM_DEFAULT }) {
  const ctx = session.context || {};
  const aUser = await fetchUserPrefs(session.aUserId);
  const bUser = await fetchUserPrefs(session.bUserId);
  aUser.tag = "A"; bUser.tag = "B";

  const locA = ctx.locA || null;
  const locB = ctx.locB || null;

  const newSig = sig(ctx, wantEach, radiusKm);

  log("pool(start)", { sessionId: session.id, want: wantEach, aUser, bUser, locA, locB });

  // Fast path: accept cache only if signature matches AND meta covers all ids
  if (Array.isArray(ctx.poolIds) && ctx.poolIds.length && ctx.poolSig === newSig && ctx.metaById) {
    const covered = ctx.poolIds.every((id) => ctx.metaById[id]?.from);
    if (covered) {
      log("pool(cache-hit)", { sessionId: session.id, poolCount: ctx.poolIds.length });
      return { poolIds: ctx.poolIds, metaById: ctx.metaById };
    }
  }

  if (!locA && !locB) {
    log("pool(no-locations)", { sessionId: session.id });
    await prisma.groupSwipeSession.update({
      where: { id: session.id },
      data: { context: { ...ctx, poolIds: [], metaById: {}, poolSig: newSig } },
    });
    return { poolIds: [], metaById: {} };
  }

  const picks = [];
  if (locA) picks.push(...await fetchForUserAt({ user: aUser, loc: locA, want: wantEach, radiusKm }));
  if (locB) picks.push(...await fetchForUserAt({ user: bUser, loc: locB, want: wantEach, radiusKm }));

  // Deduplicate, preserve first origin ("from")
  const metaById = {};
  const poolIds = [];
  for (const p of picks) {
    if (!metaById[p.id]) {
      metaById[p.id] = { from: p.from };
      poolIds.push(p.id);
    }
  }

  log("pool(combined)", { sessionId: session.id, total: poolIds.length, ids: poolIds });

  await prisma.groupSwipeSession.update({
    where: { id: session.id },
    data: { context: { ...ctx, poolIds, metaById, poolSig: newSig, builtAt: new Date().toISOString() } },
  });

  return { poolIds, metaById };
}

module.exports = {
  getOrBuildSessionPool,
  fetchUserPrefs,
};
