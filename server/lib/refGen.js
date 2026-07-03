// server/lib/refGen.js
// Lightweight unique reference generator for the new division models
// (CID-2026-A1B2C3 style). Not a sequential counter like IA's CaseCounter —
// good enough for these divisions' scope; swap for a real counter table if
// sequential refs are ever needed.
function nextRef(prefix) {
  const stamp = Date.now().toString(36).toUpperCase();
  const rand  = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${prefix}-${stamp}-${rand}`;
}

module.exports = { nextRef };
