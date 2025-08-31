// ...top unchanged

function participantsFromSessionOrEvents(s) {
  // Gather distinct userIds from the swipe events (order preserved)
  const evUsers = Array.from(new Set((s.events || []).map(e => e.userId)));

  // Prefer existing columns first
  let host = s.startedById || s.aUserId || s.bUserId || evUsers[0] || null;
  // Friend = the “other” participant if we can find one
  let friend = evUsers.find(id => id !== host) || (s.aUserId && s.aUserId !== host ? s.aUserId : null) || (s.bUserId && s.bUserId !== host ? s.bUserId : null) || null;

  return { hostUserId: host, friendUserId: friend };
}

async function backfillOne(sessionId) {
  const s = await prisma.groupSwipeSession.findUnique({
    where: { id: sessionId },
    include: { events: { orderBy: { createdAt: 'asc' } } },
  });
  if (!s) return console.log(`❌ no session ${sessionId}`);

  const existing = await prisma.groupMatch.findUnique({ where: { sessionId: s.id } });
  if (existing) return console.log(`↷ already has groupMatch ${existing.id} for session ${s.id}`);
  if (s.status !== 'completed') return console.log(`↷ session ${s.id} not completed, skipping`);
  if (!s.events.length) return console.log(`↷ session ${s.id} has 0 events, skipping`);

  const { hostUserId, friendUserId } = participantsFromSessionOrEvents(s);
  if (!hostUserId || !friendUserId) {
    console.log(`⚠️ session ${s.id} has insufficient participants (host=${hostUserId} friend=${friendUserId}), skipping`);
    return;
  }

  const outcome = computeGroupOutcome(s.events);

  await prisma.groupMatch.upsert({
    where: { sessionId: s.id },
    create: {
      // IMPORTANT: nested relation in create (relationMode=prisma)
      session: { connect: { id: s.id } },
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
  if (only) return backfillOne(only);

  // Prisma relation filter: sessions with NO match
  const sessions = await prisma.groupSwipeSession.findMany({
    where: { status: 'completed', match: { is: null } },
    select: { id: true },
    orderBy: { endedAt: 'desc' },
    take: 200,
  });

  console.log(`Found ${sessions.length} sessions to backfill…`);
  for (const { id } of sessions) {
    try { await backfillOne(id); } catch (e) { console.error(`❌ failed ${id}`, e); }
  }
}
