// server/routes/sco19.js — division features not built yet.
// Mounted at /api/sco19 behind requireAuth + requireDivision. Returns a simple
// "coming soon" until this division's real tools are specified.
const express = require('express');
const router  = express.Router();

router.get('/', (req, res) => res.json({ comingSoon: true, division: 'sco19' }));

module.exports = router;
