// server/routes/aiReview.js
const express = require('express');
const { analyzeEvidence } = require('../lib/aiReview');
const { getActiveOffenses } = require('../lib/offenses');

const router = express.Router();

// GET /api/ai-review/offenses — the active offence catalog (for reference)
router.get('/offenses', async (req, res) => {
  try { res.json(await getActiveOffenses()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/ai-review — { description?, medalLink?, video? (data URL) }
router.post('/', async (req, res) => {
  const { description, medalLink, video } = req.body || {};
  if (!description?.trim() && !medalLink?.trim() && !video) {
    return res.status(400).json({ error: 'Provide a medal.tv link, a video, or a description.' });
  }

  let videoBase64 = null, videoMime = null;
  if (video && typeof video === 'string') {
    const m = video.match(/^data:([^;]+);base64,(.+)$/);
    if (m) { videoMime = m[1]; videoBase64 = m[2]; }
    else videoBase64 = video;
  }

  try {
    const result = await analyzeEvidence({
      description: description?.trim() || null,
      medalLink:  medalLink?.trim() || null,
      videoBase64, videoMime,
    });
    res.json(result);
  } catch (err) {
    console.error('[AI review] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
