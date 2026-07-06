// server/middleware/stepup.js — passkey step-up gate for sensitive actions.
//
// Opt-in by design: if the acting user has NO passkeys registered, the gate is
// a no-op (they can't be locked out of features by a security control they
// never set up). Once a user registers a passkey, sensitive actions require a
// fresh passkey step-up (verified within STEP_UP_WINDOW_MS on this session).
const prisma = require('../lib/db');

const STEP_UP_WINDOW_MS = 10 * 60 * 1000;

function requireStepUp(req, res, next) {
  (async () => {
    try {
      const count = await prisma.passkey.count({ where: { userId: req.user.id } });
      if (count === 0) return next(); // no passkeys → not enrolled → pass through

      let ok = false;
      if (req.sessionId) {
        const s = await prisma.session.findUnique({ where: { id: req.sessionId }, select: { stepUpAt: true } });
        ok = !!(s && s.stepUpAt && (Date.now() - new Date(s.stepUpAt).getTime()) < STEP_UP_WINDOW_MS);
      }
      if (ok) return next();
      return res.status(401).json({ error: 'Passkey verification required.', code: 'STEP_UP_REQUIRED' });
    } catch (e) {
      // Never hard-fail a request because the step-up check errored — log and allow.
      console.warn('[StepUp] check failed (allowing):', e.message);
      return next();
    }
  })();
}

module.exports = { requireStepUp, STEP_UP_WINDOW_MS };
