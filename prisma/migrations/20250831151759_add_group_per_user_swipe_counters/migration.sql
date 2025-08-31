-- AlterTable
ALTER TABLE "public"."group_swipe_sessions" ADD COLUMN     "a_swipes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "b_swipes" INTEGER NOT NULL DEFAULT 0;
