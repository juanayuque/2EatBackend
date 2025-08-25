-- AlterTable
ALTER TABLE "photos" ALTER COLUMN "name" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "restaurants" ALTER COLUMN "international_phone_number" SET DATA TYPE TEXT,
ALTER COLUMN "primary_type_display_name" SET DATA TYPE TEXT,
ALTER COLUMN "plus_code" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "reviews" ALTER COLUMN "author" SET DATA TYPE TEXT;
