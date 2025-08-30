/*
  Warnings:

  - You are about to drop the column `friendUserId` on the `group_swipe_sessions` table. All the data in the column will be lost.
  - You are about to drop the column `hostUserId` on the `group_swipe_sessions` table. All the data in the column will be lost.
  - You are about to drop the column `totalSwipes` on the `group_swipe_sessions` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "public"."GroupRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELED');

-- DropForeignKey
ALTER TABLE "public"."group_swipe_sessions" DROP CONSTRAINT "group_swipe_sessions_friendUserId_fkey";

-- DropForeignKey
ALTER TABLE "public"."group_swipe_sessions" DROP CONSTRAINT "group_swipe_sessions_hostUserId_fkey";

-- DropIndex
DROP INDEX "public"."group_swipe_sessions_friendUserId_status_idx";

-- DropIndex
DROP INDEX "public"."group_swipe_sessions_hostUserId_status_idx";

-- AlterTable
ALTER TABLE "public"."group_swipe_sessions" DROP COLUMN "friendUserId",
DROP COLUMN "hostUserId",
DROP COLUMN "totalSwipes",
ADD COLUMN     "aUserId" TEXT,
ADD COLUMN     "bUserId" TEXT,
ADD COLUMN     "startedById" TEXT;

-- CreateTable
CREATE TABLE "public"."group_requests" (
    "id" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "status" "public"."GroupRequestStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "group_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "group_requests_toUserId_status_idx" ON "public"."group_requests"("toUserId", "status");

-- CreateIndex
CREATE INDEX "group_requests_fromUserId_status_idx" ON "public"."group_requests"("fromUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "group_requests_fromUserId_toUserId_key" ON "public"."group_requests"("fromUserId", "toUserId");

-- CreateIndex
CREATE INDEX "group_swipe_sessions_aUserId_idx" ON "public"."group_swipe_sessions"("aUserId");

-- CreateIndex
CREATE INDEX "group_swipe_sessions_bUserId_idx" ON "public"."group_swipe_sessions"("bUserId");

-- CreateIndex
CREATE INDEX "group_swipe_sessions_status_idx" ON "public"."group_swipe_sessions"("status");

-- CreateIndex
CREATE INDEX "group_swipe_sessions_startedById_idx" ON "public"."group_swipe_sessions"("startedById");

-- AddForeignKey
ALTER TABLE "public"."group_swipe_sessions" ADD CONSTRAINT "group_swipe_sessions_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."group_swipe_sessions" ADD CONSTRAINT "group_swipe_sessions_aUserId_fkey" FOREIGN KEY ("aUserId") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."group_swipe_sessions" ADD CONSTRAINT "group_swipe_sessions_bUserId_fkey" FOREIGN KEY ("bUserId") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."group_requests" ADD CONSTRAINT "group_requests_fromUserId_fkey" FOREIGN KEY ("fromUserId") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."group_requests" ADD CONSTRAINT "group_requests_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "public"."users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
