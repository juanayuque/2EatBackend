-- CreateTable
CREATE TABLE "restaurants" (
    "id" TEXT NOT NULL,
    "google_place_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "latitude" DECIMAL(10,7) NOT NULL,
    "longitude" DECIMAL(10,7) NOT NULL,
    "formatted_address" TEXT,
    "international_phone_number" VARCHAR(50),
    "website_uri" TEXT,
    "primary_type_display_name" VARCHAR(100),
    "rating" DECIMAL(2,1),
    "user_rating_count" INTEGER,
    "price_level" INTEGER,
    "serves_vegetarian_food" BOOLEAN DEFAULT false,
    "editorial_summary" TEXT,
    "plus_code" VARCHAR(255),
    "takeout" BOOLEAN DEFAULT false,
    "dine_in" BOOLEAN DEFAULT false,
    "curbside_pickup" BOOLEAN DEFAULT false,
    "delivery" BOOLEAN DEFAULT false,
    "outdoor_seating" BOOLEAN DEFAULT false,
    "allows_dogs" BOOLEAN DEFAULT false,
    "parking_options" JSONB,
    "regular_opening_hours" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "restaurants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "restaurant_id" TEXT NOT NULL,
    "author" VARCHAR(255) NOT NULL,
    "text" TEXT,
    "rating" DECIMAL(2,1) NOT NULL,
    "publish_time" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "photos" (
    "id" TEXT NOT NULL,
    "restaurant_id" TEXT NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "width_px" INTEGER,
    "height_px" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "photos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "restaurants_google_place_id_key" ON "restaurants"("google_place_id");

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photos" ADD CONSTRAINT "photos_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
