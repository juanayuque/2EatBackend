// routes/geocode.js
require('dotenv').config();

const express = require('express');
const axios = require('axios');
const NodeCache = require('node-cache');
const verifyFirebaseToken = require('../middleware/auth');

const router = express.Router();
const geoCache = new NodeCache({ stdTTL: 60 * 60 * 6, checkperiod: 120 }); // cache ~6h

// Rounds coords so nearby points share cache keys (reduces external calls)
function roundCoord(n, precision = 2) {
  const f = Math.pow(10, precision);
  return Math.round(n * f) / f;
}

function normalizeCityFromBDC(j) {
  // BigDataCloud fields
  return j?.city || j?.locality || j?.principalSubdivision || null;
}

function normalizeCityFromNominatim(j) {
  // Nominatim address hierarchy
  const a = j?.address || {};
  return a.city || a.town || a.village || a.hamlet || a.municipality || a.county || a.state || null;
}

/**
 * GET /api/reverse-geocode?lat=..&lng=..
 * Free providers with caching:
 * 1) BigDataCloud (no key, CORS friendly)
 * 2) Nominatim (OSM, fair-use), used as fallback
 */
router.get('/reverse-geocode', verifyFirebaseToken, async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'Missing lat/lng' });

  // Localize results where possible
  const lang = (req.headers['accept-language'] || 'en').split(',')[0]?.trim() || 'en';

  // Cache by rounded coords; reduces load and respects free-tier limits
  const key = `rg:${roundCoord(Number(lat))},${roundCoord(Number(lng))}:${lang}`;
  const cached = geoCache.get(key);
  if (cached) return res.json(cached);

  // --- BigDataCloud first ---
  try {
    const bdcUrl =
      `https://api.bigdatacloud.net/data/reverse-geocode-client` +
      `?latitude=${encodeURIComponent(lat)}` +
      `&longitude=${encodeURIComponent(lng)}` +
      `&localityLanguage=${encodeURIComponent(lang)}`;

    const bdc = await axios.get(bdcUrl, {
      timeout: 4000,
      headers: { 'User-Agent': '2eatapp.com/1.0 (reverse-geocode)' },
    });

    const city = normalizeCityFromBDC(bdc.data);
    if (city) {
      const payload = {
        city,
        formattedAddress: bdc?.data?.localityInfo?.informative?.[0]?.name || null,
        source: 'bigdatacloud',
      };
      geoCache.set(key, payload);
      return res.json(payload);
    }
  } catch (_) {
    // Fall through to Nominatim
  }

  // --- Nominatim fallback ---
  try {
    const nomUrl =
      `https://nominatim.openstreetmap.org/reverse` +
      `?lat=${encodeURIComponent(lat)}` +
      `&lon=${encodeURIComponent(lng)}` +
      `&format=jsonv2&zoom=10&addressdetails=1&accept-language=${encodeURIComponent(lang)}`;

    const nom = await axios.get(nomUrl, {
      timeout: 5000,
      headers: {
        'User-Agent': '2eatapp.com/1.0 (reverse-geocode; contact@2eatapp.com)',
        Referer: 'https://2eatapp.com',
      },
    });

    const city = normalizeCityFromNominatim(nom.data);
    const payload = {
      city: city || null,
      formattedAddress: nom?.data?.display_name || null,
      source: 'nominatim',
    };
    geoCache.set(key, payload);
    return res.json(payload);
  } catch (_) {
    return res.status(502).json({ error: 'Reverse geocode failed (all providers)' });
  }
});

module.exports = router;
