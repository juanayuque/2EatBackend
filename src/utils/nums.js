// utils/num.js (or inline helper)
function asNum(v) {
  if (v == null) return null;
  // Prisma Decimal has toNumber(); fall back to Number(v) for plain numbers/strings
  try {
    if (typeof v.toNumber === "function") return v.toNumber();
  } catch {}
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

module.exports = { asNum };
