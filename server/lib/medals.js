// server/lib/medals.js — MET Awards & Decorations ("medals").
// A member earns medals for personal achievements. They're displayed on the
// profile from two sources, unioned + de-duped:
//   1) the MET-server Discord role for each medal (captured at login →
//      user.metRoleIds) — this is what lets a member hold SEVERAL medals; and
//   2) their rank in the Awards & Decorations Roblox group (ranks 91–100 map to
//      the medals), best-effort.
// Role ids default to the ones the MET team supplied; each can be overridden with
// MEDAL_<KEY>_ROLE_ID and the group with AWARDS_GROUP_ID.

// Ordered highest → lowest (Medal of Honour is the top award).
const MEDALS = [
  { key: 'MEDAL_OF_HONOUR',            name: 'Medal of Honour',            emoji: '🎖️', rank: 100, roleId: '1513172376005902476', desc: 'The highest award in the group for truly exceptional service.' },
  { key: 'COMMISSIONERS_CROSS',        name: "Commissioner's Cross",       emoji: '🏅', rank: 99,  roleId: '1525437172654673940', desc: 'Extraordinary leadership over a long period.' },
  { key: 'COMMISSIONERS_COMMENDATION', name: "Commissioner's Commendation",emoji: '🦁', rank: 98,  roleId: '1525437288421658664', desc: "Personally awarded by the Commissioner for exceptional service." },
  { key: 'JADES_COMMENDATION',         name: "Jade's Commendation",        emoji: '⭐', rank: 97,  roleId: '1525437643343527936', desc: 'Personally awarded by a member from the Jade Command team for exceptional service.' },
  { key: 'DISTINGUISHED_SERVICE',      name: 'Distinguished Service Medal',emoji: '👑', rank: 96,  roleId: '1525437350715588758', desc: '1 year of dedicated service.' },
  { key: 'VETERAN_SERVICE',            name: 'Veteran Service Medal',      emoji: '🤝', rank: 95,  roleId: '1525440912296247307', desc: '6 months of active service.' },
  { key: 'LONG_SERVICE',               name: 'Long Service Medal',         emoji: '🌟', rank: 94,  roleId: '1525440971368566835', desc: '3 months of active service.' },
  { key: 'DIVISION_ACHIEVEMENT',       name: 'Division Achievement Medal', emoji: '📚', rank: 93,  roleId: '1525441026561413160', desc: 'Excellent contribution to a specialist division.' },
  { key: 'OFFICER_OF_THE_MONTH',       name: 'Officer of the Month',       emoji: '🏆', rank: 92,  roleId: '1426732485202415659', desc: 'Best performing officer each month.' },
  { key: 'OFFICER_OF_THE_WEEK',        name: 'Officer of the Week',        emoji: '🏆', rank: 91,  roleId: '1426950474631872584', desc: 'Best performing officer each week.' },
];

function awardsGroupId() { return process.env.AWARDS_GROUP_ID || '1085556941'; }
function medalRoleId(m)  { return process.env[`MEDAL_${m.key}_ROLE_ID`] || m.roleId; }

// Resolve the medals a member holds. `metRoleIds` = their MET-server Discord role
// ids; `awardsRank` = their (numeric) rank in the Awards & Decorations group, or
// null. Returns the ordered (highest-first) list of held medals:
//   → [{ key, name, emoji, rank, roleId, desc, sources:['role'|'group'] }]
function medalsForMember({ metRoleIds, awardsRank } = {}) {
  const ids = new Set((Array.isArray(metRoleIds) ? metRoleIds : []).map(String));
  const rank = Number.isFinite(Number(awardsRank)) ? Number(awardsRank) : null;
  const out = [];
  for (const m of MEDALS) {
    const rid = medalRoleId(m);
    const sources = [];
    if (rid && ids.has(String(rid))) sources.push('role');
    if (rank != null && rank === m.rank) sources.push('group');
    if (sources.length) {
      out.push({ key: m.key, name: m.name, emoji: m.emoji, rank: m.rank, roleId: String(rid), desc: m.desc, sources });
    }
  }
  return out; // already in highest-first order (MEDALS is ordered)
}

module.exports = { MEDALS, awardsGroupId, medalRoleId, medalsForMember };
