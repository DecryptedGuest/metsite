// server/lib/cad/services.js
// Binds the pure CAD services to the real Prisma client for the running app.
// Tests instantiate the factories directly with a mock instead.
const prisma = require('../db');
const { createUnitsService } = require('./units.service');
const { createDispatchService } = require('./dispatch.service');
const { createPncService } = require('./pnc.service');

module.exports = {
  units:    createUnitsService(prisma),
  dispatch: createDispatchService(prisma),
  pnc:      createPncService(prisma),
};
