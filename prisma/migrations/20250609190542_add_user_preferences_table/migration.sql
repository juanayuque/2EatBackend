-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'NON_BINARY', 'PREFER_NOT_TO_SAY');

-- CreateEnum
CREATE TYPE "BudgetLevel" AS ENUM ('VERY_CHEAP', 'CHEAP', 'MODERATE', 'EXPENSIVE', 'VERY_EXPENSIVE');

-- CreateTable
CREATE TABLE "users" (
    "firebase_uid" TEXT NOT NULL,
    "age" INTEGER,
    "gender" "Gender",
    "search_distance" INTEGER,
    "budget_range" "BudgetLevel"[],
    "dietary_needs" TEXT[],
    "preferred_cuisines" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("firebase_uid")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_firebase_uid_key" ON "users"("firebase_uid");
