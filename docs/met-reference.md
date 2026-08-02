# MET Dashboard — Reference & Spec

Single source of truth for the MET-specific rules and data the dashboard is built
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
| MET (umbrella) | `17275620` | Drives MET-wide rank/quota tier; icon = dashboard brand |
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

## `/discipline` (Discord) ✅

Direct disciplinary action, no case attached — the IA case pipeline with the
case removed and the case link demoted to an optional field.

- Runs in `DISCIPLINE_GUILD_ID` (defaults to `DISCORD_GUILD_ID`).
- **Who can run it**: Internal Affairs (the IA site role), or Deputy
  Commissioner and above in the MET group. Checked in this order: the dashboard
  account's IA role → a configured Discord role (`METHICOMM_ROLE_ID`,
  `IA_COMMAND_ROLE_IDS`) → live MET group rank via RoVer. Nobody needs a dashboard
  account to use it.
- **Strikes escalate.** Picking "Strike (auto-escalate)" reads what the officer
  already has — from the punishment table, from approved cases, and from the
  strike roles they are actually wearing — and issues the next one up. Naming a
  specific strike explicitly overrides the ladder. It refuses to guess what
  comes after Strike 3 and asks for an explicit Termination / Blacklist /
  Suspension instead.
- **Nothing happens until Confirm.** The panel is ephemeral and shows the
  officer, their MET rank, their record, what the action resolved to and every
  side effect it is about to cause, then asks. It warns about the two things
  that silently do nothing: an exile with no linked Roblox account, and a timed
  punishment with no `days`.
- Applies the Discord role, demotes or exiles in the group where the action
  calls for it, posts the **same administrative-log embed the case system
  posts**, and DMs the officer with a link to their record.
- A failing step doesn't abandon the rest — the panel says which step failed and
  whether the punishment is on record. A closed DM is not treated as a failure.

**Punishment roles survive a rejoin** (`server/lib/punishmentPersist.js`).
Discord drops roles when someone leaves, which used to make leaving-and-
rejoining a way to shed a strike. On `guildMemberAdd` the bot re-applies the
roles for punishments that are still active — not expired, not lifted, not
appealed. `PUNISHMENT_REAPPLY=off` disables it.

## XP `/xp` (Discord) ✅

An XP balance per officer, with rank derived from it and promotion off the back
of it.

**The ladder** — thresholds are TOTALS, not costs. An officer on 15 XP *is* a
Sergeant; they don't spend it.

| XP | Rank |
|----|------|
| 0–1 | Community Support Officer (CSO) |
| 2–14 | Constable (CON) |
| 15–39 | Sergeant (SGT) |
| 40–99 | Inspector (INS) |
| 100 | Chief Inspector (CINS) |

100 is also the **ceiling** — the most anybody can hold. XP exists to promote
people up to Chief Inspector, so there is nothing above it to earn towards, and
an uncapped balance would put a Chief Inspector on 4,000 XP with nowhere to go.
Anyone whose MET rank is already above Chief Inspector sits at the ceiling.

Rank is derived from the balance rather than stored, so `XP_THRESHOLDS`
re-ranks everybody immediately with no backfill.

**XP rank follows GROUP rank, not the other way round.** Somebody is only a
Community Support Officer here if that is what they actually are in the group.
The first time the system sees an officer it places them from their live group
rank:

- a rank the ladder names → the floor of that rank (a serving Sergeant starts
  on 15, not 0)
- a rank *above* the ladder (Superintendent, Commander) → the ceiling (100),
  since that is the top of what XP governs
- a rank *below* it (Awaiting Training, Recruit) or one that can't be read →
  **no XP row at all**. They show as *Unranked*, not as a CSO. Giving them any
  XP places them.

Ranks the ladder doesn't name are placed by their group rank *number* against
the numbers of the rolesets it does name, so the group can rename or add ranks
without this breaking.

**The command**

- `/xp` — your own card: **Rank** (their real MET rank, badged with the
  server's own insignia emoji — `:CON:`, `:SGT:`, `:CINS:` …), XP against the
  next threshold, standing, a progress bar, Roblox avatar and profile link, and
  recent XP activity. There is no separate "MET group rank" row: their MET rank
  *is* their rank.
- `/xp officers:@a` — their card. `officers:@a @b @c` — a compact table.
- `/xp officers:@a @b action:add value:5 reason:"Event"` — change it.

`officers` is a string, not a user option, because Discord has no multi-user
option type. Typing `@` still opens the member picker and inserts a real
mention, so it behaves like one — and it also accepts raw ids, Discord
usernames and Roblox usernames (resolved back through RoVer), which a user
option can't.

Viewing is public — a stats card is meant to be seen. Changing XP answers
ephemerally, because the XP log channel is the public record.

**Who can change it**, checked cheapest first:

1. the FLP officer role (`FLP_OFFICER_ROLE_ID`, default `1431554710594388018`)
2. **Administrator** in the server
3. Deputy Commissioner and above in the MET group

plus anything in `XP_MANAGER_ROLE_IDS`. Internal Affairs on its own is **not**
enough — an investigator needs one of the above as well. Anyone can view.
Nobody can award themselves.

**Promotion.** Crossing a threshold promotes the officer in the MET Roblox
group, DMs them, and posts to the XP log — all three outcomes reported on the
panel, including when the group rank *didn't* move. It fires once per rank:
`promotedRank` on the balance is what stops a repeat.

**Demotion.** Losing XP back across a threshold demotes, the same way in
reverse: the group rank moves down, the officer is DM'd with the reason the XP
came off, and it goes on the XP log. The demotion post does **not** ping them —
a promotion is worth someone's attention, being demoted in a public channel is
not.

One hard guard: a demotion will **never** touch somebody whose group rank is
above the ladder. XP tops out at Chief Inspector, so without that check a
Superintendent who lost a couple of XP would be dropped to Constable by a
system that has no business ranking them at all. Their XP still moves; their
rank doesn't.

**Serving officers are seeded, not promoted.** The first time the system sees
somebody it sets their balance to the floor of the rank they already hold and
marks it as already reached. Without that, giving a serving Inspector their
first XP point would congratulate them on making Constable.

**Logs** go to `XP_LOG_CHANNEL_ID` (default `1531317662360146092`) — one embed
per change (who, how much, before → after, why) and one per promotion. A change
never pings the channel; a promotion does ping the officer.

Every balance has its full audit trail in `xp_events` — one row per change and
one per promotion, each naming who did it.

## Telling the officer ✅

`server/lib/officerNotice.js` — one format, three callers. A case approval, a
direct action and a granted appeal are the same event from where the officer is
standing (their record changed), and all three used to be told differently or
not at all: a case approval notified the *submitter* and left the officer to
find out when a role appeared on their account.

- **Punished** (`notifyPunished`) — the action list in the case-log wording,
  the reason, the notes, the infraction id, any expiry, and whether it was a
  reviewed case or a direct action. Never claims an investigation happened when
  one didn't.
- **Appealed** (`notifyAppealed`) — what was lifted, who granted it, their rank
  and why, plus anything that still has to be undone by hand.

Both link to the officer's own record. `MEMBER_ACTION_DM=off` silences them.

Retired actions (`retired: true` in `ACTION_CONFIG`, excluded from
`ACTION_NAMES` but kept in `ALL_ACTION_NAMES`):

- **Disciplinary Strike 3** — two strikes, then Termination.
- **Verbal Warning** — the role it pointed at is the Written Warning role, so
  issuing one gave somebody a written warning.

## MET emoji ✅

Everywhere the bot, its embeds, the webhooks and the site used a stock unicode
emoji, they use a MET one instead, so Discord and the dashboard show the same
mark for the same thing. Tabler icons are untouched.

- Artwork: `scripts/emoji/manifest.js` (flat SVG, read at ~22px).
- `node scripts/build-emoji.js` rasterises it to `client/public/img/emoji/*.png`
  (committed) and regenerates `client/public/js/emoji-map.js`.
- Discord: `server/lib/emoji.js` uploads them to the **bot application** 12s
  after it connects, and re-checks hourly. Application emoji belong to the bot
  rather than to a server, so they render in DMs and anywhere else the bot
  posts — which guild emoji do not — and there are 2000 slots instead of 50.
  `e('met_tick')` in bot/webhook code. A guild upload (`EMOJI_GUILD_ID`,
  `EMOJI_STORE=guild`) is the fallback if the application route is refused.
- Ranks use the **server's own** emoji, not ours: `server/lib/rankEmoji.js`
  maps a rank name to `:CON:` / `:SGT:` / `:CINS:` and so on by looking them up
  in the bot's guild caches. Those are the insignia the server already
  recognises. A rank with no matching emoji renders as plain text.
- Site: `met.e('met_tick')` from `client/public/js/emoji.js`.
- It degrades rather than breaks — until the upload lands (or if it can't:
  missing "Manage Expressions", no emoji slots left) everything falls back to
  the unicode character it replaced. `GET /api/dev/emoji` shows what is live;
  `POST /api/dev/emoji/sync {"force":true}` re-uploads after an artwork change.
- Manifest order is upload priority, because a full guild stops the upload
  part-way.

## IA dashboard layout ✅

Nine casework-ish tabs became two, and two duplicates became one.

**Casework** — one tab for cases *and* tickets, with two selectors: **Cases /
Tickets** and **Everyone's / Mine**, defaulting to everyone's. The four pages
this replaces (My Cases, All Cases, My Tickets, All Tickets) were the same
table with different filters, and moving between them meant leaving the page.
The panels are unchanged and shown/hidden by the selector, so every search box,
filter tab and renderer still behaves exactly as it did.

**Pending** — supervisor+ only. **Pending Cases** (the old Review Queue) and
**Pending Tickets** side by side, both with approve/deny in the row. Pending
tickets used to be a status filter buried inside All Tickets.

Old page ids (`my-cases`, `all-cases`, `tickets`, `all-tickets`, `review`) are
resolved to the merged pages in `navigateTo`, so notification deep links, the
overview shortcuts and "review this case" all keep working unchanged.

**Case documents** are written as part of filing a case — the modal opens on
"Write the document" and the case link is generated from it. No Documents tab;
the archive is still reachable from the Casework footer.

**Quota & Database** absorbed Activity Tracking, which was its own tab showing
the same members' points against the same targets.

**Audit Log** and **Quota Check** each had two sidebar entries pointing at the
same page, under "Command" and "Oversight". One of each now.

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
