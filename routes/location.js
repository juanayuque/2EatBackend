// backend/routes/location.js
require('dotenv').config();

const express = require('express');
const router = express.Router();
const axios = require('axios');
const prisma = require('../src/prisma');
const verifyFirebaseToken = require('../middleware/auth');

/* ----------------------------- helpers ----------------------------- */
function mapPriceLevelEnum(str) {
  // Places API v1 priceLevel enums -> 1..4
  switch (str) {
    case 'PRICE_LEVEL_INEXPENSIVE': return 1;
    case 'PRICE_LEVEL_MODERATE': return 2;
    case 'PRICE_LEVEL_EXPENSIVE': return 3;
    case 'PRICE_LEVEL_VERY_EXPENSIVE': return 4;
    default: return null;
  }
}

function haversineKm(a, b) {
  if (!a || !b) return null;
  const toRad = (x) => (x * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ----------------------- photo proxy (no auth) ---------------------- */
/**
 * Streams a Google Places photo to the client without exposing your API key.
 * Usage: GET /api/places/photo?name=places/XXX/photos/YYY&maxWidthPx=800
 */
router.get('/places/photo', async (req, res) => {
  try {
    const { name, maxWidthPx = 800 } = req.query;
    if (!name) return res.status(400).json({ error: "Missing 'name' photo id" });

    const url = `https://places.googleapis.com/v1/${encodeURIComponent(
      name
    )}/media?maxWidthPx=${maxWidthPx}&key=${process.env.GOOGLE_API_KEY}`;

    const response = await axios.get(url, { responseType: 'arraybuffer' });
    res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
    res.send(response.data);
  } catch (err) {
    console.error('Photo proxy error:', err?.response?.data || err.message);
    res.status(500).json({ error: 'Failed to load photo' });
  }
});

/* -------------------- nearby restaurants (secured) ------------------- */
router.get('/location-info', verifyFirebaseToken, async (req, res) => {
  const { lat, lng, radius } = req.query;

  const latNum = parseFloat(lat);
  const lngNum = parseFloat(lng);
  if (!isFinite(latNum) || !isFinite(lngNum)) {
    return res.status(400).json({ error: 'Invalid lat/lng' });
  }

  const userPoint = { lat: latNum, lng: lngNum };
  const searchRadius = Math.min(Number(radius) || 1000, 50000); // default 1km, max 50km

  try {
    // Google Places API v1 — Nearby search
    const placesResponse = await axios.post(
      'https://places.googleapis.com/v1/places:searchNearby',
      {
        locationRestriction: {
          circle: {
            center: { latitude: latNum, longitude: lngNum },
            radius: searchRadius,
          },
        },
        includedTypes: ['restaurant'],
        maxResultCount: 20,
        // rankPreference: 'DISTANCE', // optional: favor nearest
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': process.env.GOOGLE_API_KEY,
          // field mask: request only fields we use
          'X-Goog-FieldMask': [
            'places.id',
            'places.displayName',
            'places.location',
            'places.formattedAddress',
            'places.priceLevel',
            'places.rating',
            'places.userRatingCount',
            'places.primaryTypeDisplayName',
            'places.editorialSummary',
            'places.photos.name',
            'places.photos.widthPx',
            'places.photos.heightPx',
            'places.websiteUri',
            'places.internationalPhoneNumber',
            'places.regularOpeningHours',
            'places.takeout',
            'places.dineIn',
            'places.curbsidePickup',
            'places.delivery',
            'places.outdoorSeating',
            'places.parkingOptions',
            'places.servesVegetarianFood',
            'places.plusCode',
          ].join(','),
        },
      }
    );

    const baseUrl = (process.env.BACKEND_PUBLIC_URL || '').replace(/\/+$/, ''); // e.g., https://2eatapp.com

    const restaurants = (placesResponse.data.places || []).map((place) => {
      const pCoords = place.location
        ? { lat: place.location.latitude, lng: place.location.longitude }
        : null;

      const distance = haversineKm(userPoint, pCoords) || 0;
      const priceLevel = mapPriceLevelEnum(place.priceLevel);

      const firstPhoto = Array.isArray(place.photos) && place.photos.length > 0 ? place.photos[0] : null;
      const photoUrl = firstPhoto
        ? `${baseUrl}/api/places/photo?name=${encodeURIComponent(firstPhoto.name)}&maxWidthPx=800`
        : null;

      return {
        googlePlaceId: place.id,
        name: place.displayName?.text || 'N/A',
        latitude: place.location?.latitude ?? null,
        longitude: place.location?.longitude ?? null,
        formattedAddress: place.formattedAddress || 'N/A',
        internationalPhoneNumber: place.internationalPhoneNumber || null,
        websiteUri: place.websiteUri || null,
        primaryTypeDisplayName: place.primaryTypeDisplayName?.text || null,

        rating: place.rating ?? null,
        userRatingCount: place.userRatingCount ?? 0,
        priceLevel,                   // 1..4 or null (normalized)
        distance,                     // km (number)

        editorialSummary: place.editorialSummary?.text || null,
        servesVegetarianFood: !!place.servesVegetarianFood,

        regularOpeningHours: place.regularOpeningHours || null,
        takeout: !!place.takeout,
        dineIn: !!place.dineIn,
        curbsidePickup: !!place.curbsidePickup,
        delivery: !!place.delivery,
        outdoorSeating: !!place.outdoorSeating,
        parkingOptions: place.parkingOptions || null,

        plusCode: place.plusCode?.globalCode || null,

        photos: Array.isArray(place.photos)
          ? place.photos.map((photo) => ({
              name: photo.name,
              widthPx: photo.widthPx,
              heightPx: photo.heightPx,
            }))
          : [],

        photoUrl, // convenient, ready-to-use URL via our proxy
      };
    });

    /* --------------------- Prisma upsert (optional) --------------------- */
    // Note: consider deduping child relations (reviews/photos) to avoid duplicates on repeated fetches.
    for (const r of restaurants) {
      try {
        await prisma.restaurant.upsert({
          where: { googlePlaceId: r.googlePlaceId },
          update: {
            name: r.name,
            latitude: r.latitude,
            longitude: r.longitude,
            formattedAddress: r.formattedAddress,
            internationalPhoneNumber: r.internationalPhoneNumber,
            websiteUri: r.websiteUri,
            primaryTypeDisplayName: r.primaryTypeDisplayName,
            rating: r.rating,
            userRatingCount: r.userRatingCount,
            priceLevel: r.priceLevel,
            regularOpeningHours: r.regularOpeningHours,
            takeout: r.takeout,
            dineIn: r.dineIn,
            curbsidePickup: r.curbsidePickup,
            delivery: r.delivery,
            outdoorSeating: r.outdoorSeating,
            parkingOptions: r.parkingOptions,
            servesVegetarianFood: r.servesVegetarianFood,
            editorialSummary: r.editorialSummary,
            plusCode: r.plusCode,
            updatedAt: new Date(),
          },
          create: {
            googlePlaceId: r.googlePlaceId,
            name: r.name,
            latitude: r.latitude,
            longitude: r.longitude,
            formattedAddress: r.formattedAddress,
            internationalPhoneNumber: r.internationalPhoneNumber,
            websiteUri: r.websiteUri,
            primaryTypeDisplayName: r.primaryTypeDisplayName,
            rating: r.rating,
            userRatingCount: r.userRatingCount,
            priceLevel: r.priceLevel,
            regularOpeningHours: r.regularOpeningHours,
            takeout: r.takeout,
            dineIn: r.dineIn,
            curbsidePickup: r.curbsidePickup,
            delivery: r.delivery,
            outdoorSeating: r.outdoorSeating,
            parkingOptions: r.parkingOptions,
            servesVegetarianFood: r.servesVegetarianFood,
            editorialSummary: r.editorialSummary,
            plusCode: r.plusCode,
            photos: {
              create: (r.photos || []).map((p) => ({
                name: p.name,
                widthPx: p.widthPx,
                heightPx: p.heightPx,
              })),
            },
          },
        });
      } catch (dbError) {
        console.error(`DB upsert error for ${r.name}:`, dbError);
      }
    }
    /* ------------------- end Prisma upsert (optional) ------------------- */

    res.json({ nearbyRestaurants: restaurants });
  } catch (error) {
    console.error('Google Places API error:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch nearby restaurants' });
  }
});

module.exports = router;
