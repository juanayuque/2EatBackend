// index.js or your Express route
require('dotenv').config();
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();
app.use(cors());
const PORT = 3000;

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
console.log("API KEY (partial):", GOOGLE_API_KEY ? GOOGLE_API_KEY.substring(0, 5) + "..." : "Undefined"); // More secure log

app.get("/api/location-info", async (req, res) => {
  const { lat, lng } = req.query;

  try {
    const placesResponse = await axios.post(
      "https://places.googleapis.com/v1/places:searchNearby",
      {
        locationRestriction: {
          circle: {
            center: {
              latitude: parseFloat(lat),
              longitude: parseFloat(lng),
            },
            radius: 1000, // in meters
          },
        },
        includedTypes: ["restaurant"], // Filter for only restaurants
        maxResultCount: 20, // Max results per call for searchNearby
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": process.env.GOOGLE_API_KEY,
          // Request all the detailed fields you need here
          "X-Goog-FieldMask": "places.displayName,places.location,places.rating,places.userRatingCount,places.reviews,places.photos,places.formattedAddress,places.websiteUri,places.regularOpeningHours,places.servesVegetarianFood,places.priceLevel,places.editorialSummary,places.primaryTypeDisplayName,places.plusCode,places.internationalPhoneNumber,places.takeout,places.dineIn,places.curbsidePickup,places.delivery,places.outdoorSeating,places.parkingOptions,places.allowsDogs",
        },
      }
    );

    // Map the response to include all relevant place data
    const restaurants = (placesResponse.data.places || []).map((place) => {
      return {
        // Basic Info
        name: place.displayName?.text || 'N/A',
        latitude: place.location?.latitude,
        longitude: place.location?.longitude,
        formattedAddress: place.formattedAddress || 'N/A',
        internationalPhoneNumber: place.internationalPhoneNumber || 'N/A',
        websiteUri: place.websiteUri || 'N/A',
        primaryTypeDisplayName: place.primaryTypeDisplayName?.text || 'N/A',

        // Ratings & Reviews
        rating: place.rating || null,
        userRatingCount: place.userRatingCount || 0,
        reviews: place.reviews ? place.reviews.map(review => ({
            author: review.authorAttribution?.displayName || 'Anonymous',
            text: review.text || '',
            rating: review.rating || null,
            publishTime: review.publishTime || ''
        })) : [],

        // Operational Info
        priceLevel: place.priceLevel || null, // e.g., PRICE_LEVEL_UNSPECIFIED, PRICE_LEVEL_MODERATE
        regularOpeningHours: place.regularOpeningHours || null, // Contains details like 'weekdayDescriptions'
        takeout: place.takeout || false,
        dineIn: place.dineIn || false,
        curbsidePickup: place.curbsidePickup || false,
        delivery: place.delivery || false,
        outdoorSeating: place.outdoorSeating || false,
        parkingOptions: place.parkingOptions || null, // e.g., 'freeParkingLot', 'paidGarage'
        allowsDogs: place.allowsDogs || false,

        // Dietary & Other
        servesVegetarianFood: place.servesVegetarianFood || false,
        editorialSummary: place.editorialSummary?.text || null, // AI-generated summary

        // Photos (metadata only, actual images require separate API call)
        photos: place.photos ? place.photos.map(photo => ({
            name: photo.name, // Photo resource name (e.g., 'places/ChIJw2_qL3JadkgROfI5eS0d3A/photos/CmRaAAA...
            widthPx: photo.widthPx,
            heightPx: photo.heightPx,
            // To get the actual image URL, make a separate call to:
            // `https://places.googleapis.com/v1/{photo.name}/media?key=YOUR_API_KEY&maxWidthPx={width}`
        })) : [],

        // Plus Code (for location reference)
        plusCode: place.plusCode || null,

        // You can calculate this if needed based on frontend or backend
        distance: 0,
      };
    });

    res.json({
      postcode: "N/A", // If you need a postcode, you'd integrate a reverse geocoding API call here
      nearbyRestaurants: restaurants,
    });
  } catch (error) {
    console.error("Google Places API error:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to fetch nearby restaurants" });
  }
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});