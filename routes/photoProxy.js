// Explains *why*: keeping this as its own router isolates caching and media concerns.
const express = require("express");
const axios = require("axios");
const prisma = require("../src/prisma");

const router = express.Router();

router.get("/photo", async (req, res) => {
  try {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) return res.status(503).send("photo proxy disabled");

    const raw = String(req.query.name || "");
    const name = decodeURIComponent(raw);

    const m = /^places\/([^/]+)\/photos\/([^/]+)$/.exec(name);
    if (!m) return res.status(400).send("bad name");
    const placeId = m[1];

    const w = req.query.w || req.query.maxWidthPx;
    const h = req.query.h || req.query.maxHeightPx;

    const buildMediaUrl = (photoName) => {
      const params = new URLSearchParams();
      if (w) params.set("maxWidthPx", String(w));
      if (h) params.set("maxHeightPx", String(h));
      params.set("key", apiKey);
      return `https://places.googleapis.com/v1/${photoName}/media?${params.toString()}`;
    };

    async function streamMedia(photoName) {
      const mediaUrl = buildMediaUrl(photoName);
      const head = await axios.get(mediaUrl, {
        responseType: "stream",
        maxRedirects: 0,
        validateStatus: (s) => s >= 200 && s < 400,
      });
      const finalUrl = head.status === 302 && head.headers.location ? head.headers.location : mediaUrl;
      const img = await axios.get(finalUrl, { responseType: "stream" });
      res.setHeader("Content-Type", img.headers["content-type"] || "image/jpeg");
      res.setHeader("Cache-Control", "public, max-age=86400, s-maxage=86400");
      res.setHeader("Access-Control-Allow-Origin", "*");
      img.data.pipe(res);
    }

    try {
      return await streamMedia(name);
    } catch (err) {
      const status = err?.response?.status;
      console.error("[photo] media upstream", status || "", err?.message || "");
      if (status === 400 || status === 404) {
        try {
          const det = await axios.get(
            `https://places.googleapis.com/v1/places/${placeId}?fields=photos.name&key=${apiKey}`
          );
          const newName = det?.data?.photos?.[0]?.name;
          if (newName && newName !== name) {
            try { await prisma.photo.updateMany({ where: { name }, data: { name: newName } }); } catch (_) {}
            return await streamMedia(newName);
          }
        } catch (e2) {
          console.error("[photo] details fetch failed", e2?.response?.status || "", e2?.message || "");
        }
      }
      return res.status(204).end();
    }
  } catch (e) {
    console.error("photo proxy error", e);
    return res.status(204).end();
  }
});

module.exports = router;
