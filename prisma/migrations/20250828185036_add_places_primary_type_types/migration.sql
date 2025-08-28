-- AlterTable
ALTER TABLE "public"."restaurants" ADD COLUMN     "primary_type" TEXT,
ADD COLUMN     "types" TEXT[] DEFAULT ARRAY[]::TEXT[];
