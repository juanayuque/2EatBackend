/*
  Warnings:

  - You are about to drop the column `budget_range` on the `users` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "public"."users" DROP COLUMN "budget_range",
ADD COLUMN     "budget_max" INTEGER;
