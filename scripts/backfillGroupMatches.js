// scripts/backfillGroupMatches.js
// Usage:
//   node scripts/backfillGroupMatches.js                # backfill all missing
//   SESSION_ID=cmez... node scripts/backfillGroupMatches.js   # backfill one
//
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function computeGroupOutcome(events) {
  let lastSuper = null;
  const byId = new Map(); // id -> { likes, posSum, firstPos }

  (events || []).forEach((e, idx) => {
    const id = e.restaurantId;
    const pos = Number(e.position ?? idx + 1);
    const rec = byId.get(id) || { likes: 0, posSum: 0, firstPos: null };

    if (e.action === "LIKE" || e.action === "SUPERSTAR") {
      rec.likes += 1;
      rec.posSum += pos;
      if (rec.firstPos == null) rec.firstPos = pos;
    }
    if (e.action === "SUPERSTAR") lastSuper = id;

    byId.set(id, rec);
  });

  // rank: likes desc -> posSum asc -> firstPos asc
  const rows = Array.from(byId.entries());
  rows.sort((a, b) => {
    const A = a[1], B = b[1];
    if (B.likes !== A.likes) return B.likes - A.likes;
    if ((A.posSum ?? 0) !== (B.posSum ?? 0)) return A.posSum - B.posSum;
    return (A.firstPos ?? 1e9) - (B.firstPos ?? 1e9);
  });

  const ordered = rows.map(([id]) => id);
  const winnerId = lastSuper || ordered[0] || null;

  return {
    winnerId,
    superStarId: lastSuper || null,
    top1: ordered[0] || null,
    top2: ordered[1] || null,
    top3: ordered[2] || null,
  };
}

async function backfillOne(sessionId) {
  const s = await prisma.groupSwipeSession.findUnique({
    where: { id: sessionId },
    include: { events: { orderBy: { createdAt: 'asc' } } },
  });
  if (!s) {
    console.log(`❌ no session ${sessionId}`);
    return;
  }
  const existing = await prisma.groupMatch.findUnique({ where: { sessionId: s.id } });
  if (existing) {
    console.log(`↷ already has groupMatch ${existing.id} for session ${s.id}`);
    return;
  }
  if (s.status !== 'completed') {
    console.log(`↷ session ${s.id} not completed (status=${s.status}), skipping`);
    return;
  }
  if (!s.events.length) {
    console.log(`↷ session ${s.id} has 0 events, skipping`);
    return;
  }

  const outcome = computeGroupOutcome(s.events);

  // derive host/friend same way as finalize route
  const hostUserId = s.startedById || s.aUserId || s.bUserId;
  let friendUserId = null;
  if (hostUserId === s.aUserId) friendUserId = s.bUserId || null;
  else if (hostUserId === s.bUserId) friendUserId = s.aUserId || null;
  else friendUserId = s.aUserId || s.bUserId || null;

  await prisma.groupMatch.upsert({
    where: { sessionId: s.id },
    create: {
      sessionId: s.id,
      hostUserId,
      friendUserId,
      top1RestaurantId: outcome.top1,
      top2RestaurantId: outcome.top2,
      top3RestaurantId: outcome.top3,
      superStarRestaurantId: outcome.superStarId,
      winnerRestaurantId: outcome.winnerId,
      comment: null,
    },
    update: {
      top1RestaurantId: outcome.top1,
      top2RestaurantId: outcome.top2,
      top3RestaurantId: outcome.top3,
      superStarRestaurantId: outcome.superStarId,
      winnerRestaurantId: outcome.winnerId,
    },
  });

  console.log(`✅ backfilled groupMatch for session ${s.id} — winner=${outcome.winnerId}`);
}

async function main() {
  const only = process.env.SESSION_ID && String(process.env.SESSION_ID);
  if (only) {
    await backfillOne(only);
    return;
  }

  // find completed sessions missing a match
  const sessions = await prisma.groupSwipeSession.findMany({
    where: {
      status: 'completed',
      // no GroupMatch with same sessionId
      NOT: { match: { isNot: null } }, // if you have relation named "match" on session
    },
    select: { id: true },
    orderBy: { endedAt: 'desc' },
    take: 100,
  }).catch(async () => {
    // fallback if you don't have relation alias on the model:
    const raw = await prisma.$queryRawUnsafe(`
      SELECT s.id
      FROM "GroupSwipeSession" s
      LEFT JOIN "GroupMatch" gm ON gm."sessionId" = s.id
      WHERE s.status = 'completed' AND gm.id IS NULL
      ORDER BY s."endedAt" DESC
      LIMIT 100
    `);
    return raw.map(r => ({ id: r.id }));
  });

  console.log(`Found ${sessions.length} sessions to backfill…`);
  for (const { id } of sessions) {
    try { await backfillOne(id); } catch (e) {
      console.error(`❌ failed ${id}`, e);
    }
  }
}

main()
  .catch(e => console.error(e))
  .finally(async () => { await prisma.$disconnect(); });
