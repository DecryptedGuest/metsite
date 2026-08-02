// server/lib/exile.js
// Removing somebody from the Metropolitan Police means removing them from ALL
// of it.
//
// A Termination or a Blacklist used to exile from the MET umbrella group only.
// But somebody terminated from the MET is not still a CID detective, an SCO-19
// firearms officer or an FLP responder — and every divisional group they stay
// in is a live rank, a live set of permissions on this dashboard, and a way
// back in. "Terminated" that leaves four group memberships standing is not a
// termination, it is a paperwork exercise.
//
// So this exiles from the umbrella group and then from every divisional group
// they are actually in. It reports each one separately, because a partial
// removal is exactly the thing somebody needs to know about and finish by hand.
//
// Everything is best-effort per group: one group refusing must not stop the
// rest, and a Roblox outage must not make a termination read as failed when the
// record, the role and the log all landed.

const { ALL, explicitGroupId, metGroupId, META } = require('./divisions');

/**
 * Which groups a termination should cover: the MET umbrella first, then every
 * division that has a group id configured.
 */
function exileTargets() {
  const out = [];
  const met = metGroupId();
  if (met) out.push({ key: 'MET', name: 'Metropolitan Police', groupId: String(met) });
  for (const d of ALL) {
    const gid = explicitGroupId(d);
    // Never list the same group twice — a division pinned to the umbrella group
    // would otherwise be exiled from, and reported, twice.
    if (!gid || out.some(x => x.groupId === String(gid))) continue;
    out.push({ key: d, name: (META[d] && META[d].fullName) || d, groupId: String(gid) });
  }
  return out;
}

/**
 * Exile a Roblox user from the MET and from every division they are in.
 *
 * Membership is checked before exiling so the result distinguishes "removed"
 * from "was never in it" — a report that says "removed from 5 groups" when they
 * were only in two is a report nobody can act on.
 *
 * @param {string|number} robloxUserId
 * @param {object} [opts]
 * @param {boolean} [opts.metOnly=false] skip the divisions (the old behaviour)
 * @returns {Promise<{
 *   ok: boolean,
 *   removed: Array<{key,name}>,
 *   notIn: Array<{key,name}>,
 *   failed: Array<{key,name,error}>,
 *   summary: string,
 * }>}
 */
async function exileEverywhere(robloxUserId, opts = {}) {
  const roblox = require('./roblox');
  const out = { ok: false, removed: [], notIn: [], failed: [], summary: '' };
  if (!robloxUserId) { out.summary = 'no linked Roblox account'; return out; }

  const targets = opts.metOnly ? exileTargets().slice(0, 1) : exileTargets();

  for (const t of targets) {
    let inGroup = null;
    try {
      const role = await roblox.getUserGroupRole(String(robloxUserId), t.groupId);
      inGroup = !!(role && Number(role.rank) > 0);
    } catch (err) {
      // Unknown membership is not "not a member" — try the exile and let the
      // API say. Skipping on a failed read is how somebody stays in a group.
      inGroup = null;
    }

    if (inGroup === false) { out.notIn.push({ key: t.key, name: t.name }); continue; }

    try {
      const done = await roblox.exileFromGroup(String(robloxUserId), t.groupId);
      if (done) out.removed.push({ key: t.key, name: t.name });
      else if (inGroup === null) out.notIn.push({ key: t.key, name: t.name });
      else out.failed.push({ key: t.key, name: t.name, error: 'the group refused the exile' });
    } catch (err) {
      out.failed.push({ key: t.key, name: t.name, error: err.message });
    }
  }

  // The MET umbrella is the one that has to succeed. A division refusing is
  // worth reporting and finishing by hand; the umbrella refusing means they are
  // still an officer.
  const metResult = targets[0] && (out.removed.some(x => x.key === 'MET') || out.notIn.some(x => x.key === 'MET'));
  out.ok = !!metResult;

  const bits = [];
  if (out.removed.length) bits.push(`removed from ${out.removed.map(x => x.key).join(', ')}`);
  if (out.notIn.length && !out.removed.length) bits.push('was not in any group');
  else if (out.notIn.length) bits.push(`not in ${out.notIn.map(x => x.key).join(', ')}`);
  if (out.failed.length) bits.push(`FAILED for ${out.failed.map(x => x.key).join(', ')}`);
  out.summary = bits.join(' · ') || 'nothing to do';
  return out;
}

module.exports = { exileEverywhere, exileTargets };
