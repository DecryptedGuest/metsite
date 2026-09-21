const { PrismaClient } = require('@prisma/client');
const prisma = global.__metPrisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') global.__metPrisma = prisma;
module.exports = prisma;
