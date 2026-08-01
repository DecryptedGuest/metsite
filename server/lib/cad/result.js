// server/lib/cad/result.js — shared typed-result helpers for the CAD services.
// Every service method returns one of these; it never throws for an expected
// failure. { ok:true, ...data } on success, { ok:false, error, code } on a
// handled failure. This keeps the service layer pure and trivially testable.
function ok(data) { return { ok: true, ...(data || {}) }; }
function err(code, error) { return { ok: false, code: code || 'ERROR', error: error || 'Something went wrong.' }; }
module.exports = { ok, err };
