-- CreateTable
CREATE TABLE "public"."group_swipe_sessions" (
    "id" TEXT NOT NULL,
    "hostUserId" TEXT NOT NULL,
    "friendUserId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "totalSwipes" INTEGER NOT NULL DEFAULT 0,
    "context" JSONB,

    CONSTRAINT "group_swipe_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."group_swipe_events" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "action" "public"."SwipeAction" NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "group_swipe_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."group_matches" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "hostUserId" TEXT NOT NULL,
    "friendUserId" TEXT NOT NULL,
    "top1RestaurantId" TEXT NOT NULL,
    "top2RestaurantId" TEXT,
    "top3RestaurantId" TEXT,
    "superStarRestaurantId" TEXT,
    "winnerRestaurantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "comment" TEXT,

    CONSTRAINT "group_matches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "group_swipe_sessions_hostUserId_status_idx" ON "public"."group_swipe_sessions"("hostUserId", "status");

-- CreateIndex
CREATE INDEX "group_swipe_sessions_friendUserId_status_idx" ON "public"."group_swipe_sessions"("friendUserId", "status");

-- CreateIndex
CREATE INDEX "group_swipe_events_sessionId_idx" ON "public"."group_swipe_events"("sessionId");

-- CreateIndex
CREATE INDEX "group_swipe_events_userId_idx" ON "public"."group_swipe_events"("userId");

-- CreateIndex
CREATE INDEX "group_swipe_events_restaurantId_idx" ON "public"."group_swipe_events"("restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "group_matches_sessionId_key" ON "public"."group_matches"("sessionId");

-- CreateIndex
CREATE INDEX "group_matches_hostUserId_idx" ON "public"."group_matches"("hostUserId");

-- CreateIndex
CREATE INDEX "group_matches_friendUserId_idx" ON "public"."group_matches"("friendUserId");

-- AddForeignKey
ALTER TABLE "public"."group_swipe_sessions" ADD CONSTRAINT "group_swipe_sessions_hostUserId_fkey" FOREIGN KEY ("hostUserId") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."group_swipe_sessions" ADD CONSTRAINT "group_swipe_sessions_friendUserId_fkey" FOREIGN KEY ("friendUserId") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."group_swipe_events" ADD CONSTRAINT "group_swipe_events_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "public"."group_swipe_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."group_swipe_events" ADD CONSTRAINT "group_swipe_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."group_matches" ADD CONSTRAINT "group_matches_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "public"."group_swipe_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
