-- AlterTable
ALTER TABLE "public"."users" ADD COLUMN     "lastGeoAt" TIMESTAMP(3),
ADD COLUMN     "lastGeoSource" TEXT,
ADD COLUMN     "lastLat" DECIMAL(10,7),
ADD COLUMN     "lastLng" DECIMAL(10,7);
