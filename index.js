// index.js or your Express route

// Load environment variables from a .env file into process.env
require('dotenv').config();

// Import necessary modules
const express = require("express"); // Web framework for Node.js
const axios = require("axios");   // HTTP client for making API requests
const cors = require("cors");     // Middleware to enable Cross-Origin Resource Sharing
const { PrismaClient } = require('./generated/prisma'); // Import PrismaClient

// Initialize the Express application
const app = express();

// Enable CORS for all routes, allowing frontend applications on different origins to access this API
app.use(cors());

// Define the port the server will listen on
const PORT = 3000;

// Retrieve the Google API key from environment variables
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

// Log a partial API key for debugging; avoids exposing the full key in logs
console.log("API KEY (partial):", GOOGLE_API_KEY ? GOOGLE_API_KEY.substring(0, 5) + "..." : "Undefined");

// --- Initialize Prisma Client ---
const prisma = new PrismaClient();

// Define an API endpoint to fetch nearby restaurant information
// Expects 'lat' (latitude) and 'lng' (longitude) as query parameters
app.get("/api/location-info", async (req, res) => {
  const { lat, lng } = req.query;

  try {
    // Make a POST request to Google Places API (searchNearby endpoint)
    const placesResponse = await axios.post(
      "https://places.googleapis.com/v1/places:searchNearby",
      {
        // Define the search area as a circle around the provided coordinates
        locationRestriction: {
          circle: {
            center: {
              latitude: parseFloat(lat),
              longitude: parseFloat(lng),
            },
            radius: 1000, // Search radius of 1000 meters (1 km)
          },
        },
        includedTypes: ["restaurant"], // Crucially, filter results to only include restaurants
        maxResultCount: 20, // Request up to 20 results per API call
      },
      {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": process.env.GOOGLE_API_KEY,
          // Specify which fields to retrieve from the Places API response.
          // This "field mask" optimizes performance by only fetching necessary data.
          "X-Goog-FieldMask": "places.displayName,places.location,places.rating,places.userRatingCount,places.reviews,places.photos,places.formattedAddress,places.websiteUri,places.regularOpeningHours,places.servesVegetarianFood,places.priceLevel,places.editorialSummary,places.primaryTypeDisplayName,places.plusCode,places.internationalPhoneNumber,places.takeout,places.dineIn,places.curbsidePickup,places.delivery,places.outdoorSeating,places.parkingOptions,places.allowsDogs,places.id", 
        },
      }
    );

    // Process the API response: map the raw Google Places data into a cleaner, custom format
    const restaurants = (placesResponse.data.places || []).map((place) => {
      return {
        
        // Essential contact & location details
        googlePlaceId: place.id, 
        name: place.displayName?.text || 'N/A',
        latitude: place.location?.latitude,
        longitude: place.location?.longitude,
        formattedAddress: place.formattedAddress || 'N/A',
        internationalPhoneNumber: place.internationalPhoneNumber || 'N/A',
        websiteUri: place.websiteUri || 'N/A',
        primaryTypeDisplayName: place.primaryTypeDisplayName?.text || 'N/A', // e.g., "Sushi Restaurant"

        // Customer feedback and popularity metrics
        rating: place.rating || null,
        userRatingCount: place.userRatingCount || 0,
        reviews: place.reviews ? place.reviews.map(review => ({
            author: review.authorAttribution?.displayName || 'Anonymous',
            text: review.text || '',
            rating: review.rating || null,
            publishTime: review.publishTime || ''
        })) : [],

        // Business operations and amenities
        priceLevel: place.priceLevel || null, // Price indication (e.g., 1-4, low to high)
        regularOpeningHours: place.regularOpeningHours || null, // Detailed opening hours
        takeout: place.takeout || false,
        dineIn: place.dineIn || false,
        curbsidePickup: place.curbsidePickup || false,
        delivery: place.delivery || false,
        outdoorSeating: place.outdoorSeating || false,
        parkingOptions: place.parkingOptions || null, // Parking availability
        allowsDogs: place.allowsDogs || false,

        // Specific offerings or summaries
        servesVegetarianFood: place.servesVegetarianFood || false,
        editorialSummary: place.editorialSummary?.text || null, // AI-generated text summary

        // Photo metadata; actual images require a separate API call with the `name` field
        photos: place.photos ? place.photos.map(photo => ({
            name: photo.name,
            widthPx: photo.widthPx,
            heightPx: photo.heightPx,
            // To retrieve the actual image, construct a URL like:
            // `https://places.googleapis.com/v1/${photo.name}/media?key=YOUR_API_KEY&maxWidthPx={width}`
        })) : [],

        // Plus Code for precise location referencing
        plusCode: place.plusCode || null,

        // Placeholder for distance; calculation would be done on frontend or with another API call
        distance: 0,
      };
    });

    // --- Log data to database using Prisma ---
    const savedRestaurants = [];
    for (const restaurantData of restaurants) {
      try {
        // create or update the restaurant based on googlePlaceId
        const savedRestaurant = await prisma.restaurant.upsert({
          where: { googlePlaceId: restaurantData.googlePlaceId },
          update: {
            // Update  if the restaurant already exists
            name: restaurantData.name,
            latitude: restaurantData.latitude,
            longitude: restaurantData.longitude,
            formattedAddress: restaurantData.formattedAddress,
            internationalPhoneNumber: restaurantData.internationalPhoneNumber,
            websiteUri: restaurantData.websiteUri,
            primaryTypeDisplayName: restaurantData.primaryTypeDisplayName,
            rating: restaurantData.rating,
            userRatingCount: restaurantData.userRatingCount,
            priceLevel: restaurantData.priceLevel,
            regularOpeningHours: restaurantData.regularOpeningHours,
            takeout: restaurantData.takeout,
            dineIn: restaurantData.dineIn,
            curbsidePickup: restaurantData.curbsidePickup,
            delivery: restaurantData.delivery,
            outdoorSeating: restaurantData.outdoorSeating,
            parkingOptions: restaurantData.parkingOptions,
            allowsDogs: restaurantData.allowsDogs,
            servesVegetarianFood: restaurantData.servesVegetarianFood,
            editorialSummary: restaurantData.editorialSummary,
            plusCode: restaurantData.plusCode,
          },
          create: {
            // Create all fields if the restaurant is new
            googlePlaceId: restaurantData.googlePlaceId,
            name: restaurantData.name,
            latitude: restaurantData.latitude,
            longitude: restaurantData.longitude,
            formattedAddress: restaurantData.formattedAddress,
            internationalPhoneNumber: restaurantData.internationalPhoneNumber,
            websiteUri: restaurantData.websiteUri,
            primaryTypeDisplayName: restaurantData.primaryTypeDisplayName,
            rating: restaurantData.rating,
            userRatingCount: restaurantData.userRatingCount,
            priceLevel: restaurantData.priceLevel,
            regularOpeningHours: restaurantData.regularOpeningHours,
            takeout: restaurantData.takeout,
            dineIn: restaurantData.dineIn,
            curbsidePickup: restaurantData.curbsidePickup,
            delivery: restaurantData.delivery,
            outdoorSeating: restaurantData.outdoorSeating,
            parkingOptions: restaurantData.parkingOptions,
            allowsDogs: restaurantData.allowsDogs,
            servesVegetarianFood: restaurantData.servesVegetarianFood,
            editorialSummary: restaurantData.editorialSummary,
            plusCode: restaurantData.plusCode,
            // Connect related Reviews and Photos
            reviews: {
                create: restaurantData.reviews.map(review => ({
                    author: review.author,
                    text: review.text,
                    rating: review.rating,
                    publishTime: review.publishTime ? new Date(review.publishTime) : null, // Convert to Date object
                }))
            },
            photos: {
                create: restaurantData.photos.map(photo => ({
                    name: photo.name,
                    widthPx: photo.widthPx,
                    heightPx: photo.heightPx,
                }))
            }
          },
        });
        savedRestaurants.push(savedRestaurant);
        console.log(`Saved/Updated restaurant: ${savedRestaurant.name}`);
      } catch (dbError) {
        console.error(`Error saving restaurant ${restaurantData.name} to DB:`, dbError);
      }
    }
    // --- End database logging ---

    // Send the structured restaurant data (can be the original or the saved ones)
    res.json({
      nearbyRestaurants: restaurants, // Or savedRestaurants if you want to return the DB versions
    });
  } catch (error) {
    // Log detailed error information for debugging
    console.error("Google Places API error:", error.response?.data || error.message);
    // Send a 500 status code with a user-friendly error message
    res.status(500).json({ error: "Failed to fetch nearby restaurants" });
  } finally {
    // --- Disconnect 
    await prisma.$disconnect();
  }
});

// Start the Express server and listen for incoming requests on the specified port
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});