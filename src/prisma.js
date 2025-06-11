// src/prisma.js
const { PrismaClient } = require('@prisma/client');

// Initialize PrismaClient
const prisma = new PrismaClient();

// Export the single instance
module.exports = prisma;