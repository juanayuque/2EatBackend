-- AlterTable
ALTER TABLE "public"."users" ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "emailVerified" BOOLEAN DEFAULT false,
ADD COLUMN     "photoUrl" TEXT;
