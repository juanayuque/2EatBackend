// shared enum normalization prevents diverging logic across modules.
function mapPriceLevelEnum(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  switch (String(v)) {
    case "PRICE_LEVEL_INEXPENSIVE": return 1;
    case "PRICE_LEVEL_MODERATE":    return 2;
    case "PRICE_LEVEL_EXPENSIVE":   return 3;
    case "PRICE_LEVEL_VERY_EXPENSIVE": return 4;
    default: return null;
  }
}

function normalizePriceLevel(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const s = String(v).toUpperCase();
  switch (s) {
    case "PRICE_LEVEL_INEXPENSIVE": return 1;
    case "PRICE_LEVEL_MODERATE":    return 2;
    case "PRICE_LEVEL_EXPENSIVE":   return 3;
    case "PRICE_LEVEL_VERY_EXPENSIVE": return 4;
    case "PRICE_LEVEL_UNSPECIFIED": return null;
    default: {
      if (s.includes("VERY") && s.includes("EXPENSIVE")) return 4;
      if (s.includes("EXPENSIVE")) return 3;
      if (s.includes("MODERATE")) return 2;
      if (s.includes("INEXPENSIVE") || s.includes("CHEAP")) return 1;
      const num = s.match(/\d+/);
      return num ? Number(num[0]) : null;
    }
  }
}

module.exports = { mapPriceLevelEnum, normalizePriceLevel };
