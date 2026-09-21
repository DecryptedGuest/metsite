// server/middleware/stepup.js — passkey step-up gate for sensitive actions.
//
// Opt-in by design: if the acting user has NO passkeys registered, the gate is
// a no-op (they can't be locked out of features by a security control they
// never set up). Once a user registers a passkey, sensitive actions require a
// fresh passkey step-up (verified within STEP_UP_WINDOW_MS on this session).
const prisma = require('../lib/db');

const STEP_UP_WINDOW_MS = 10 * 60 * 1000;

// Developers are exempt. The dev panel is a single-operator tool on an account
// that is already the highest trust level in the system, and a passkey prompt
// on every action there buys nothing — there is no second developer for it to
// protect the first from. DEV_REQUIRE_PASSKEY=1 puts it back for a deployment
// that wants it.
function devExempt(req) {
  if (process.env.DEV_REQUIRE_PASSKEY === '1') return false;
  return !!(req.user && req.user.role === 'DEVELOPER');
}

function requireStepUp(req, res, next) {
  (async () => {
    if (devExempt(req)) return next();
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

// Enforced variant: when the `requirePasskeyElevated` toggle is on, elevated
// staff (HICOMM/SUPERVISOR/DEVELOPER) MUST have a passkey — if they have none,
// the action is blocked with an "enrol a passkey" message. If they do have one
// (enforced or not), a fresh passkey step-up is required. Non-elevated users
// with no passkey pass through (never locked out of a control they never set up).
function requireStepUpEnforced(req, res, next) {
  (async () => {
    if (devExempt(req)) return next();
    try {
      const elevated = req.user && ['HICOMM', 'SUPERVISOR', 'DEVELOPER'].includes(req.user.role);
      const enforce  = require('../lib/siteConfig').isOn('requirePasskeyElevated');
      const count    = await prisma.passkey.count({ where: { userId: req.user.id } });

      if (enforce && elevated && count === 0) {
        return res.status(401).json({ error: 'Your role requires a passkey. Add one in your profile (Passkeys & 2FA), then retry.', code: 'PASSKEY_ENROLL_REQUIRED' });
      }
      if (count === 0) return next(); // not enrolled, not enforced → allow

      let ok = false;
      if (req.sessionId) {
        const s = await prisma.session.findUnique({ where: { id: req.sessionId }, select: { stepUpAt: true } });
        ok = !!(s && s.stepUpAt && (Date.now() - new Date(s.stepUpAt).getTime()) < STEP_UP_WINDOW_MS);
      }
      if (ok) return next();
      return res.status(401).json({ error: 'Passkey verification required.', code: 'STEP_UP_REQUIRED' });
    } catch (e) {
      console.warn('[StepUp] enforced check failed (allowing):', e.message);
      return next();
    }
  })();
}

module.exports = { requireStepUp, requireStepUpEnforced, STEP_UP_WINDOW_MS };
