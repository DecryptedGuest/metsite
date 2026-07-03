# MET Portal — Reference & Spec

Single source of truth for the MET-specific rules and data the portal is built
against. Captured from what MET provided (the build environment can't reach the
Google/Trello links, so this is transcribed from messages — correct anything
that's wrong).

> Status legend: ✅ confirmed & wired · 🟡 known but not yet built · ❓ needs info

---

## What the site is

A **MET-wide** website for every Metropolitan Police officer to:
- track their **MET quota** (and their division's quota),
- see their **disciplinary record** (their own strikes/actions),
- access their **division** tools based on their Roblox group rank.

Officers must **not** be able to see IA investigation **cases filed against
them**. (Their own disciplinary *record* on their profile is separate and they
*should* see that.)

---

## Roblox groups ✅

| Entity | Group ID | Notes |
|--------|----------|-------|
| MET (umbrella) | `17275620` | Drives MET-wide rank/quota tier; icon = portal brand |
| CID | `12697126` | |
| SCO-19 | `14063116` | |
| IA | `407296071` | Internal Affairs (pre-existing) |
| FLP | `233530818` | |
| HPC | `35685825` | |

Wired as defaults in `server/lib/divisions.js`; icons fetched from these groups.

---

## Reference documents (can't be opened from the build env — links for humans)

| Doc | Link |
|-----|------|
| MET Handbook | https://docs.google.com/document/d/11UtdyD7QO-z4pFQI3myCH0w2x2CtLIAAp2nbmkvTXK8 |
| MET Infraction List (IA penal codes / violations for cases) | https://docs.google.com/spreadsheets/d/1IAeiOW1HR-Knl9LaI3dFOTb4r0acD5U1lOuNPLo2yf8 |
| MET Crimelist (Trello) | https://trello.com/b/qiXdkO3T — **ignore citations & any crime over 10 min jailtime** |
| CID Handbook | https://docs.google.com/document/d/1P5xWoX4aUZelrjajxf1bzh40sWdaSheg90zXNDacgwg |
| CID Quota Database (Sheet) | https://docs.google.com/spreadsheets/d/1E4C8N-ezmD5cZYpFlHex-OvYZx0M_Z_xR6kQJSmyCSg |
| SCO Handbook | https://docs.google.com/document/d/1aiulthsPFTX8REqtm3aIHq1aM1ZQ8IGBmXqcNie8v2I |

IA already ships penal-code / offense libraries (`server/lib/penalCodes.js`,
`server/lib/offenses.js`) that may already cover the infraction list.

---

## Quota rules

### MET-wide 🟡 (tier from the MET group `17275620` rank)
- **Low rank** — 3 events attended / week.
- **Senior officer** — 8 events hosted / day (as a collective).
- **High rank** — exempt.
- **Internal Affairs** — exempt from MET quota.
- **Hendon Police College** — exempt from MET quota.
- **Front Line Policing** — exempt from *divisional* quota (still MET quota? ❓).
- **Console users** — must still log patrols, but are **exempt from date/time**
  on start/end logs and never disciplined for missing it.
- ❓ Which MET ranks are "low rank" vs "senior officer" vs "high rank"
  (need the MET group `17275620` rank ladder).

### SCO-19 🟡
- 7 points.
- Sergeant — 2 events hosted + 7 points.
- Inspector — 2 events hosted + 7 points.
- ❓ base "7 points" applies to which ranks; how points are earned/sourced.

### CID 🟡
- Tracked in the **CID Quota Database** sheet (link above).
- ❓ the exact per-rank targets (need the sheet contents).

### IA
- Has its own quota system already (Google Sheets via `lib/quota.js`). Exempt
  from MET quota.

---

## Division ranks

### CID rank ladder + radio callsigns ✅ (recorded; not yet used in code)
| Rank | Callsign |
|------|----------|
| Detective Constable | `DCON-XXX` |
| Detective Sergeant | `DSGT-XXX` |
| Detective Inspector | `DINS-XXX` |
| Detective Chief Inspector | `DCI-XXX` |

(Command ranks — Assistant Commander / Director+ — sit above these and are the
"high rank" / LEAD tier gate for CID.)

- ❓ Full rank ladders for SCO-19, FLP, HPC, and the MET umbrella group
  (run `npm run discover:divisions` where Roblox is reachable, or paste them).

---

## Access / privacy rules

- Division membership + rank come **only** from the division's Roblox group
  rank (no Discord-role fallback). ✅
- **High-rank (LEAD) gate** unlocks a division's restricted actions:
  Assistant Commander / Director+ in CID & SCO-19; Deputy Director+ in FLP & HPC;
  HICOMM/Supervisor in IA. 🟡 (matched by rank name; refine with full ladders)
- Officers can't see IA cases filed **against** them (IA routes are already
  gated to IA members; ❓ whether to also hide a case from an IA member who is
  its subject).

---

## HPC Final Examination ✅ (built) / 🟡 (needs data)

- Cadets with Discord role `1509521712058990743` must sit the exam (`HPC_EXAM_ROLE_ID`).
- Taken on-site at `/exam` with anti-cheat telemetry (paste, tab-switch, copy,
  right-click, devtools, keystroke-vs-length, timing → flags shown to markers). ✅
- HPC access tiers (by Roblox group rank name, provisional):
  - **Junior Instructor+** → HPC shows as one of their divisions.
  - **Database Manager+** → "Mark Final Exams" tab.
  - **Assistant Director+** → "Quota Check" tab (DB pending).
- Marker scores each question (0..max), pass = ≥ 80%; result posts to channel
  `1509522116590960640` (set `HPC_RESULTS_WEBHOOK_URL` to a webhook there) and
  shows on the cadet's profile. ✅
- 🟡 **Exam total**: the transcribed paper is **15 questions = 30 pts**, but MET
  said "/36". Send the missing questions / point values (or confirm 30) — the
  system already computes the total + 80% pass dynamically from the question list
  in `server/lib/hpcExam.js`.
- ❓ HPC rank ladder (group `35685825`) to make the "and above" tiers exact.

## Deferred (still to build)

- **Nav reframe**: a normal sign-in landing + a single MET dashboard where
  divisions live in a tab (not the current division-cards hub). Large front-end
  restructure — next up.
- **HPC quota tab** wiring — waiting on the HPC quota database.
- Per-division quotas (MET/SCO/CID) — waiting on the quota data-source decision.

## Open decisions (blocking the quota build)

1. **Quota activity data source** — where do "events attended / hosted / points
   / patrols" counts come from?
   - (a) officers log them in the site, or
   - (b) the MET bot writes per-officer totals to this DB, or
   - (c) Google Sheets (CID already has a quota sheet; IA already reads Sheets).
   The mix (CID sheet, SCO points, MET events) leans toward **(c)/(b)** with a
   per-division quota definition + data source.
2. **Case privacy** — is the existing IA gating enough, or also hide cases from
   their IA-member subject?
