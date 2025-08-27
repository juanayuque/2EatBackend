-- CreateEnum
CREATE TYPE "public"."SwipeAction" AS ENUM ('LIKE', 'PASS', 'SUPERSTAR');

-- DropEnum
DROP TYPE "public"."BudgetLevel";

-- CreateTable
CREATE TABLE "public"."swipe_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "totalSwipes" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "swipe_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."swipe_events" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "action" "public"."SwipeAction" NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "swipe_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."superstars" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "restaurantId" TEXT NOT NULL,
    "sessionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "superstars_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."matches" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "top1RestaurantId" TEXT NOT NULL,
    "top2RestaurantId" TEXT,
    "top3RestaurantId" TEXT,
    "superStarRestaurantId" TEXT,
    "winnerRestaurantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "swipe_sessions_userId_status_idx" ON "public"."swipe_sessions"("userId", "status");

-- CreateIndex
CREATE INDEX "swipe_events_userId_idx" ON "public"."swipe_events"("userId");

-- CreateIndex
CREATE INDEX "swipe_events_restaurantId_idx" ON "public"."swipe_events"("restaurantId");

-- CreateIndex
CREATE INDEX "superstars_sessionId_idx" ON "public"."superstars"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "superstars_userId_restaurantId_key" ON "public"."superstars"("userId", "restaurantId");

-- CreateIndex
CREATE UNIQUE INDEX "matches_sessionId_key" ON "public"."matches"("sessionId");

-- CreateIndex
CREATE INDEX "matches_userId_idx" ON "public"."matches"("userId");

-- AddForeignKey
ALTER TABLE "public"."swipe_sessions" ADD CONSTRAINT "swipe_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."swipe_events" ADD CONSTRAINT "swipe_events_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "public"."swipe_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."swipe_events" ADD CONSTRAINT "swipe_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."superstars" ADD CONSTRAINT "superstars_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."matches" ADD CONSTRAINT "matches_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."matches" ADD CONSTRAINT "matches_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "public"."swipe_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
