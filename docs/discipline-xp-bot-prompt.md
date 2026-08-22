# Build Prompt — `/discipline`, `/xp`, `/loa` Discord Bot

> Paste everything below into a fresh Claude Code session. It is fully
> self-contained — the agent needs no other repository, file or context.
> Replace the `<<PLACEHOLDERS>>` where you already know the values; every one of
> them is read from an environment variable at runtime, so you can also leave
> them and fill the `.env` in later.

---

## ROLE AND GROUND RULES

You are building a **new, standalone Discord bot from scratch** in an empty
directory. Stack: **Node.js 20+, `discord.js` v14, Prisma + PostgreSQL**. There
is no existing code to read and no repository to inspect — this document is the
complete and only specification. Build exactly what it says.

The bot serves a Roblox law-enforcement roleplay community. Staff members
discipline each other through formal "cases", and staff earn weekly quota points
(the community calls them XP) for the casework they submit. The bot exposes
**exactly three slash command groups** — `/discipline`, `/xp`, `/loa` — and
nothing else.

Rules you must follow without exception:

1. **Do not invent features.** No extra commands, no extra fields, no "helpful"
   additions. If something is not in this document, it does not exist.
2. **Do not rename anything.** Action names, embed titles, field labels, log
   lines and error strings are contractual — real people read them and other
   tooling matches on them. Reproduce every quoted string character for
   character, including the emojis, the `• ` prefixes, and the double space in
   the boot log line.
3. **Every number is deliberate.** Intervals, point values, retry counts, batch
   sizes, colours and character limits are given explicitly. Use them verbatim;
   do not round, tune or "improve" them.
4. **Everything is fail-soft at runtime.** Any Discord, Google or Roblox failure
   is caught, logged and retried where specified — it must never crash a command
   or abort an approval halfway. The single exception is boot: a missing
   *required* env var must fail loudly and exit with a clear message.
5. **No hard-coded IDs, anywhere.** Role IDs, guild IDs, group IDs, sheet IDs
   and webhook URLs come from `process.env`, read at call time (not captured at
   module load), so they can be changed without a redeploy.

### Glossary

| Term | Meaning |
|---|---|
| **Case** | One disciplinary record filed against a staff member. Carries one or more punishments. |
| **Subject / officer** | The staff member the case is *against*. Confusingly, the code field is `officerDiscordId` — keep that name. |
| **Submitter / filer** | The staff member who *wrote* the case. This is who earns the points. |
| **IA** | Internal Affairs — the staff department that files cases. |
| **HICOMM** | High Command — the top permission tier. |
| **Supervisor** | The middle tier: can approve cases, but not Blacklist or Termination. |
| **XP / quota points** | Points earned for approved work, tracked per weekday in a Google Sheet. |
| **Exile** | Removing someone from the Roblox group. |
| **LOA** | Leave of Absence — a marker written into the sheet that exempts someone from quota. |
| **IOTW** | Investigator of the Week — a Discord role that reduces its holder's weekly target. |
| **RoVer** | The third-party bot/API that links Discord accounts to Roblox accounts. |

### What you are building, in one paragraph

A staff member runs `/discipline file` against someone, choosing punishments
from a fixed catalog of eleven. That creates a PENDING case. A reviewer runs
`/discipline approve`, and the bot then: posts a formal "Administrative Log"
embed to a Discord webhook, assigns the Discord role for each punishment,
records an expiry for the timed ones (a background worker strips those roles
when they lapse), removes the subject from the Roblox group if any punishment
is exile-flagged, drops them one Roblox rank if the punishment is a Demotion,
and finally awards **+4 points to the person who filed the case** — written into
a Google Sheet through a durable outbox that retries until it lands. `/xp` reads
and administers those points; `/loa` writes the leave-of-absence marker.

---

# 1. `/discipline` — punishments

## 1.1 The catalog (exact)

Eleven actions, this exact order and these exact names. `exile` = also remove
them from the Roblox group. `timed` = takes a duration in days and auto-expires.

| # | Action | Role env var | exile | timed |
|---|--------|--------------|-------|-------|
| 1 | `Verbal Warning`        | `ROLE_VERBAL_WARNING`  | no  | no  |
| 2 | `Written Warning`       | `ROLE_WRITTEN_WARNING` | no  | no  |
| 3 | `Zero Tolerance`        | `ROLE_ZT`              | no  | **yes** |
| 4 | `Suspension`            | `ROLE_SUSPENDED`       | no  | **yes** |
| 5 | `Activity Strike`       | `ROLE_ACTIVITY_STRIKE` | no  | no  |
| 6 | `Disciplinary Strike 1` | `ROLE_STRIKE_1`        | no  | no  |
| 7 | `Disciplinary Strike 2` | `ROLE_STRIKE_2`        | no  | no  |
| 8 | `Disciplinary Strike 3` | `ROLE_STRIKE_3`        | no  | no  |
| 9 | `Demotion`              | *(none)*               | no  | no  |
| 10| `Termination`           | *(none)*               | **yes** | no |
| 11| `Blacklist`             | `ROLE_BLACKLIST`       | **yes** | no |

Store as one `ACTION_CONFIG` object whose `roleId` is a **getter** reading
`process.env` at call time, so role IDs change without a redeploy. Export
`ACTION_NAMES` in the order above and validate every submitted action against
it — reject anything else with `Invalid action: <name>`.

A single case may carry **multiple** punishments at once.

**`Blacklist` and `Termination` are High Command only.** A Supervisor-tier
reviewer approving a case containing either gets:
`Only HICOMM can approve a case involving a Blacklist or Termination.`

## 1.2 Subcommands

- **`/discipline file`** — subject (Discord user *or* Roblox username), reason,
  notes, evidence link, and a multi-select of punishments with an optional
  duration in days for each timed one. Creates a `PENDING` case; replies with
  the case ref.
- **`/discipline approve <ref>`** — runs the pipeline in 1.3. Reviewer-gated.
- **`/discipline deny <ref> [note]`** — sets `DENIED`, writes an audit row.
- **`/discipline lookup <user>`** — that member's **approved** case history and
  which punishments are still active
  (`active = !roleRemoved && (!expiresAt || expiresAt > now)`). Pending/denied
  cases are listed separately — only approved ones count toward the record.

Defer the reply immediately on anything slow so the interaction token can't
expire. `✅` on success, `❌ <message>` on failure.

## 1.3 The approval pipeline — implement in this order

1. Guards: 404 if no such case; `409 Case is not pending` if not PENDING; 403 on
   the Supervisor + Blacklist/Termination combination above. Nobody reviews
   their own case.
2. Set `APPROVED`, write a `CaseAction` row (`APPROVED`, notes
   `Approved by HICOMM/Developer`).
3. Fetch the subject's Roblox headshot for the embed thumbnail.
4. If the case was filed Roblox-only, resolve the subject's Discord ID via the
   Roblox↔Discord verification API and **persist it**, so the log can mention
   them and roles/expiry can apply.
5. Build the action list: `case.actions` if present, else one entry from the
   legacy `case.action` string.
6. **Post the Administrative Log embed** (1.4) and save the returned message id
   to `case.logMessageId`.
7. For each action with a resolved role (env lookup first, the roleId
   snapshotted on the case as fallback): assign the role, then create a
   `CasePunishment` row with
   `expiresAt = durationDays ? now + durationDays*86400000 : null`.
8. **Exile** — if the subject has a Roblox id and any action has `exile: true`,
   call `DELETE https://groups.roblox.com/v1/groups/<groupId>/users/<userId>`
   **once per case**, not once per action. Audit it with exactly
   `Roblox group exile executed for "<Action>" (user <id>)` or
   `Roblox group exile failed for "<Action>" (user <id>)`.
9. **Demotion** — if any action is `Demotion`, drop the subject **one rank**:
   list the group's roles, take those with `rank > 0` and `rank < currentRank`,
   pick the highest, set it. Audit `Group demotion: <from> → <to> (user <id>)`
   or `Group demotion failed: <reason> (user <id>)`.
10. **Award +4 XP** to the member who **filed** the case (not the subject) via
    the outbox in 2.2, label `case #<n>`.

Editing an approved case **PATCHes the original webhook message in place**
(`PATCH <webhookUrl>/messages/<messageId>`) and retitles it
`Staff Consequences & Discipline (updated)`. If that fails (message deleted),
post a fresh one and store the new id.

## 1.4 The Administrative Log embed (exact)

Posted to a Discord webhook with `?wait=true` so the message id comes back.
No emojis in this embed — it is a plain formal notice.

- `content`: `<@officerDiscordId>` when known (pings the subject)
- `color`: `0x2f3136`
- `title`: `Staff Consequences & Discipline`
- `author.name`: `Signed, Internal Affairs High Command`,
  `author.icon_url`: `<<SIGNATURE_ICON_URL>>`
- `thumbnail`: the subject's Roblox headshot when available
- Fields, all `inline: false`, in this order, with the `• ` inside the field
  **name**:
  - `• Staff Member:` → `<@id>`, else
    `[username](https://www.roblox.com/users/<id>/profile)`, else the bare
    username, else the italic literal `*Unknown Officer*`
  - `• Punishment(s):` → the list below
  - `• Reason:` → reason or `N/A`
  - `• Notes:` → notes or `N/A`
- `footer.text`: `Infraction ID | #<n>` (or `Infraction ID | pending`)
- `timestamp`: ISO now

Punishment list — one bullet each:
```
• Suspension (7d)
• Verbal Warning
• Blacklist
```
Append ` (<n>d)` when `durationDays` is set, otherwise ` (Permanent)` —
**except** `Verbal Warning`, `Termination`, `Demotion` and `Blacklist`, which
show no duration suffix at all when they carry no role.

## 1.5 Timed-punishment expiry worker

- Runs on boot, then **every 5 minutes** (`setInterval(fn, 5 * 60 * 1000)`).
- Finds `CasePunishment` where `expiresAt <= now` AND `roleRemoved = false` AND
  `roleId != null`.
- Removes the role in `DISCORD_GUILD_ID`; on success sets `roleRemoved = true`
  and logs `Expired role <roleId> removed from <userId> (#<caseRef>)`.
- A failure leaves `roleRemoved = false` so the next tick retries — forever.
- Generic: only `Zero Tolerance` and `Suspension` are timed in practice, but
  anything with an `expiresAt` expires.

---

# 2. `/xp` — quota points

## 2.1 Earning

| Event | Points | Label |
|-------|--------|-------|
| Case approved | **+4** | `case #<n>` |
| Ticket log approved | **+2** | `ticket <ref>` |

Points go to the **submitter**, never the subject.

## 2.2 Durable outbox — never lose a point

- On approval, `upsert` a `QuotaAward` keyed `@@unique([refType, refId])`, so a
  re-approve or retry can **never** double-award. Then kick the processor after
  **50 ms**.
- Worker: `setInterval` every **30 s**, plus a catch-up run **8 s** after boot.
- Each pass takes up to **25** PENDING rows, oldest first.
- Success → `DONE`. Failure → `attempts + 1`; at **40 attempts** mark `FAILED`
  and log
  `[quota] award <label> FAILED after <n> tries — discord=<id>, roblox=<name>. Add the points manually.`

## 2.3 The sheet

Points live in a Google Sheet: one row per member, one column per weekday.

- **Column discovery is by header text**, scanning every row (headers may not be
  row 1):
  - username: `username`, `roblox username`, `roblox user`, `roblox`, `user`
  - discord id: `discord id`, `discordid`, `discord`
  - rank: `rank`, `role`
  - days: `sun`…`sat`, full day names, or any header starting with those
- **Row matching**, in this order: Discord ID exact → Discord ID digits-only →
  Roblox username case-insensitive → Roblox username *normalised* (lowercase,
  strip everything not `a-z0-9`, so `Bruh_Lord`, `bruh lord` and `bruhlord` all
  match). Try both the stored and the live-resolved username — people rename.
- Write path: **(1)** a Google Apps Script Web App bound to the sheet
  (`QUOTA_WEBHOOK_URL` + `QUOTA_WEBHOOK_SECRET`) — this is the path that
  actually works; **(2)** fall back to the service account
  (`GOOGLE_SERVICE_ACCOUNT_JSON`, scope
  `https://www.googleapis.com/auth/spreadsheets`) read-modify-writing the one
  day cell.
- **Serialise writes** through an in-process promise chain — concurrent
  read-modify-writes on one cell lose updates.
- "Today" resolves in `QUOTA_TIMEZONE` (default `Europe/London`), not UTC.
- Log every write: `[quota] +<points> <label> → row <r>, <day> = <newValue>`.
- Non-numeric cells (`EX`, `LOA`) are preserved verbatim and never summed.

## 2.4 Weekly targets by rank

Matched case-insensitively against the sheet's rank cell, **in this order**:
```
LOA                                                  → exempt, target 0,  tier "LOA"
/director/                                           → exempt, target 0,  tier "High Command"
/senior\s*investigator|supervisor/                   → target 20,         tier "Middle Command"
/junior\s*investigator|probationary\s*investigator/  → target 30,         tier "Low Command"
anything else / blank                                → target null, tier null (unknown)
```
`remaining = exempt ? 0 : max(0, target - total)`.

## 2.5 Quota-reduction role / Investigator of the Week

- A Discord role in `QUOTA_REDUCTION_GUILD_ID` (`QUOTA_REDUCTION_ROLE_ID`)
  reduces its holder's weekly target by `QUOTA_REDUCTION_AMOUNT` (default
  **10**), floored at 0, flagged `reducedBy` so it can be displayed. Exempt
  members are unaffected. Cache role-holder lookups; invalidate on change.
- Setting IOTW makes one user the **exclusive** holder: fetch all guild members,
  remove the role from everyone else, add it to the target. A falsy id clears it
  from everyone.

## 2.6 Rows that are never members

Skip any row whose username or rank matches: `username, roblox username,
roblox user, roblox, user, discord id, discordid, discord, rank, role,
high command, middle command, low command, staff information + quota, total,
warning, strikes, timezone, wtbt`.

## 2.7 Subcommands

- **`/xp me`** and **`/xp check <user>`** — points per weekday, total, rank,
  tier, target, `reducedBy`, remaining.
- **`/xp review`** — builds and posts the Weekly Quota Review embed (2.8).
- **`/xp reset`** — HICOMM only, confirmation button, then clears every numeric
  day cell for member rows. `EX`/`LOA` markers and any formula TOTAL column are
  left untouched. Webhook path first, service account as fallback.
- **`/xp exempt <user>`** — writes `EX` across that member's day cells.
- **`/xp iotw <user>`** — sets the exclusive Investigator of the Week role.

## 2.8 Weekly Quota Review embed (exact)

To `QUOTA_RESULTS_WEBHOOK_URL` (falling back to the case webhook), with
`content` pinging `<<QUOTA_PING_ROLE_ID>>`:

- `color`: `0x4a8fff`
- `title`: `Weekly Quota Review — <week label>`
- `description`: one line per member —
  `✅ **<username>** · <rank> — <total>/<target> pts` on a pass,
  `❌ **<username>** · <rank> — <total>/<target> pts — <reason, ≤120 chars>` on
  a fail. Exempt members show `Exempt` in place of the points. The Investigator
  of the Week gets ` — ⭐ IOTW` appended. Past 3900 chars, truncate with
  `\n… (list truncated)`.
- Fields, all inline: `Reviewed by` (`<@id>` or name), `Passed`, `Failed`
- `footer.text`: `Internal Affairs · Quota Check`, plus an ISO timestamp

---

# 3. `/loa` — leave of absence

LOA is a **sheet marker**, not a separate table — that's the whole system.

- **`/loa set <user>`** — writes the literal `LOA` into every one of that
  member's weekday cells. Same two-path write as everything else: Apps Script
  webhook first (`action: 'exempt'`, `marker: 'LOA'`, `username`), service
  account as fallback.
- Row lookup for the marker write is by **username, case-insensitive exact**. If
  there's no username column: `No username column found.` If the member isn't
  on the sheet: `Member not found on the sheet.` If neither write path is
  configured: `Quota sheet is not configured.`
- A rank cell reading `LOA` makes that member **exempt with target 0, tier
  "LOA"** (see 2.4), and LOA counts as a form of exemption in the weekly review.
- `LOA` cells are non-numeric, so 2.3 preserves them verbatim and never sums
  them; `/xp reset` leaves them alone.
- **HICOMM only** (excluding Supervisor) — the same gate as `/xp reset`,
  `/xp exempt` and `/xp iotw`.

---

# 4. Data model (Prisma)

```prisma
enum CaseStatus { PENDING APPROVED DENIED }

model Case {
  id               String     @id @default(uuid())
  caseRef          String     @unique     // "#1", "#2", … sequential
  userId           String                 // who FILED it
  officerDiscordId String?                // the SUBJECT
  robloxUserId     String?
  robloxUsername   String?
  action           String                 // display: "Suspension, Demotion"
  actions          Json?                  // [{ action, roleId, durationDays }]
  reason           String
  notes            String     @default("N/A")
  caseLink         String?                // evidence link
  logMessageId     String?                // for in-place webhook edits
  status           CaseStatus @default(PENDING)
  createdAt        DateTime   @default(now())
  updatedAt        DateTime   @updatedAt
  caseActions      CaseAction[]
  casePunishments  CasePunishment[]
}

model CasePunishment {
  id           String    @id @default(uuid())
  caseId       String
  action       String
  roleId       String?
  durationDays Int?
  expiresAt    DateTime?   // null = permanent
  roleRemoved  Boolean   @default(false)
}

model CaseAction {          // audit trail
  id          String   @id @default(uuid())
  caseId      String
  actionType  String   // CREATED | APPROVED | DENIED | EDITED
  performedBy String
  notes       String?
  createdAt   DateTime @default(now())
}

model CaseCounter { id Int @id @default(1)  count Int @default(0) }

model QuotaAward {
  id             String   @id @default(uuid())
  refType        String   // 'case' | 'ticket'
  refId          String
  discordId      String?
  robloxUsername String?
  points         Int
  label          String?
  status         String   @default("PENDING")  // PENDING | DONE | FAILED
  attempts       Int      @default(0)
  lastError      String?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  @@unique([refType, refId])
  @@index([status])
}
```

**Case refs**: atomic upsert-increment on `CaseCounter` id 1, formatted `#<count>`.
Never random, never reused.

---

# 5. Permissions

```
ROLE_IA              = <<STAFF_ROLE_ID>>          # can file
ROLE_SUPERVISOR      = <<SUPERVISOR_ROLE_ID>>     # can approve, NOT Blacklist/Termination
ROLE_HICOMM          = <<HIGH_COMMAND_ROLE_ID>>   # approve anything; /xp reset, /xp exempt, /xp iotw, /loa
DEVELOPER_DISCORD_ID = <<YOUR_DISCORD_USER_ID>>   # always full access
DEVELOPER_ROLE_ID    = <<OPTIONAL_ROLE_ID>>
```

---

# 6. Roblox integration

- Identity: Discord ↔ Roblox via the verification API (`ROVER_API_KEY`), with a
  stored fallback and **cooldown/backoff on 429s** so a rate-limit never stalls
  an approval. Cache group-role lookups ~30 minutes.
- Group actions need `.ROBLOSECURITY` (`ROBLOX_COOKIE`) with X-CSRF-TOKEN
  handling: seed the token from a throwaway authed request, then transparently
  re-fetch and retry once on a 403 token mismatch.
- If `ROBLOX_GROUP_ID` or `ROBLOX_COOKIE` is unset, log
  `Group exile skipped — ROBLOX_GROUP_ID or ROBLOX_COOKIE not set.` and carry
  on. Never throw.

---

# 7. Bot mechanics

- Intents: `Guilds` + `GuildMembers`.
- Ready log line exactly: ``🤖  Discord bot online as <tag>`` (two spaces).
- Guard every guild/member/role call: not-ready → warn and return false, never
  throw. Log `Role <id> assigned to <user>` / `Role <id> removed from <user>`,
  and `Failed to assign role <id> to <user>: <msg>` on failure.

---

# 8. Non-negotiables

- Role IDs, group IDs, webhook URLs, sheet IDs: **env vars only**, read at call
  time. No hard-coded IDs anywhere.
- Idempotent: one award per case/ticket ever; one exile per case; approving
  twice is a `409`.
- Every state change writes a `CaseAction` row.
- Fail loudly at **boot** if a required env var is missing; fail soft at runtime
  for everything optional.

---

# 9. Deliverables

1. The bot: `index.js`, `lib/actions.js`, `lib/discipline.js`, `lib/quota.js`,
   `lib/roblox.js`, `lib/webhook.js`, `commands/discipline.js`,
   `commands/xp.js`, `commands/loa.js`, `prisma/schema.prisma`, plus the Apps
   Script (`scripts/quota-webhook.gs`) for the sheet write path.
2. A `README.md`: creating the bot, inviting it with Manage Roles (its role must
   sit **above** every punishment role), the Google service account and sharing
   the sheet with its `client_email`, deploying the Apps Script.
3. **The `.env.example` and the plain-English env-var table** — grouped as Core,
   Discord, Roles, Roblox, Google/Quota, Webhooks. I'm adding the bot accounts
   to the Roblox groups myself, so state which group permissions each Roblox
   feature needs (exile, rank change).


---

# 10. APPENDIX — exact external API contracts

You have no reference implementation to copy from, so here is every external
call spelled out.

## 10.1 Roblox — identity (Discord → Roblox)

Primary, with `ROVER_API_KEY`:
```
GET https://registry.rover.link/api/guilds/<DISCORD_GUILD_ID>/discord-to-roblox/<discordUserId>
Authorization: Bearer <ROVER_API_KEY>
→ 200 { robloxId: 123456 }   → String(robloxId)
→ 404                        → not linked; cache the null
→ body.errorCode === 'user_not_found' → not linked; cache the null
→ 429                        → TRIP THE COOLDOWN (below) and return cached/null
```
Public fallback when no key is set (rate-limited, warn about it):
`GET https://verify.eryn.io/api/user/<discordUserId>`.

**Resolution order, and this order matters:** in-memory cache (TTL ~30 min) →
the Roblox id already stored on that user's row in your own DB → RoVer. Hitting
your own database before RoVer is what keeps you off the rate limit.

**The 429 cooldown**: on a 429, set `roverCooldownUntil` from the response's
`detail.retryAfter` (default a few minutes) and, while it holds, **never call
RoVer at all** — serve the cached or stored value, or null. Retrying into a
rate-limit extends the ban and stalls approvals. A missing Roblox link is never
an error: exile and demotion are simply skipped for that case.

## 10.2 Roblox — reads (public, no auth)

```
Headshot   GET https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=<id>&size=150x150&format=Png&isCircular=false
           → data[0].imageUrl
Membership GET https://groups.roblox.com/v2/users/<id>/groups/roles
           → data[] — find the entry whose group.id === ROBLOX_GROUP_ID; gives { group, role:{ id, name, rank } }
```

## 10.3 Roblox — writes (authenticated)

Every write goes through one `robloxAuthFetch(url, options, allowRetry = true)`
helper:

- Headers: `Cookie: .ROBLOSECURITY=<ROBLOX_COOKIE>`,
  `Content-Type: application/json`, and `X-CSRF-TOKEN` when one is cached.
- **On a 403, Roblox returns a fresh token in the `x-csrf-token` response
  header.** Capture it, then retry the request exactly once with
  `allowRetry = false`. Without this, every write fails.
- Warm the token at boot with a throwaway
  `POST https://auth.roblox.com/v2/logout` (its own failure is irrelevant —
  you only want the header), so the first real action doesn't pay for the retry.

The calls themselves:
```
Exile        DELETE https://groups.roblox.com/v1/groups/<groupId>/users/<userId>
List ranks   GET    https://groups.roblox.com/v1/groups/<groupId>/roles
                    → roles[] of { id, name, rank }, sort ascending by rank
Change rank  PATCH  https://groups.roblox.com/v1/groups/<groupId>/users/<userId>
                    body { roleId: <the target role's id> }
```
**Demotion algorithm**: read the subject's current `rank`; from the group's
roles take every role with `rank > 0` **and** `rank < currentRank`; pick the
**highest** of those; set it. `rank > 0` excludes the guest role. If nothing
qualifies, fail with reason `already at the lowest rank`.

Group permissions the bot's Roblox account needs: **Remove Members** for exile,
**Manage lower-ranked member ranks** for demotion, and its own group rank must
sit **above** everyone it acts on.

## 10.4 Google Sheet — the Apps Script web app (primary write path)

Ship a `scripts/quota-webhook.gs` for the user to paste into their sheet
(Extensions → Apps Script → Deploy → Web app, *Execute as: Me*, *Who has access:
Anyone*). The `/exec` URL becomes `QUOTA_WEBHOOK_URL`.

The bot POSTs JSON, always with `redirect: 'follow'` (Apps Script 302s):
```jsonc
{ "secret": "<QUOTA_WEBHOOK_SECRET>", "action": "add",    "username": "...", "discordId": "...", "points": 4 }
{ "secret": "<QUOTA_WEBHOOK_SECRET>", "action": "exempt", "username": "...", "marker": "EX" }   // or "LOA"
{ "secret": "<QUOTA_WEBHOOK_SECRET>", "action": "reset" }
```
Responses are `{ ok: true, row, day, newValue }` / `{ ok: true, cleared }` /
`{ ok: false, error }`. A wrong secret returns `{ ok:false, error:'bad secret' }`.

The script itself must:
- Verify the secret before doing anything.
- **Take a `LockService.getScriptLock()` with `waitLock(30000)` around the whole
  handler**, and `SpreadsheetApp.flush()` before releasing. Two approvals
  landing together would otherwise each read the old cell value and write back
  `old + points`, silently losing one increment. On lock timeout return
  `{ ok:false, error:'busy — could not acquire lock' }`.
- Resolve "today" in its own `TIMEZONE` constant (`Europe/London`).
- Carry the same header-detection and row-matching rules as §2.3, so both write
  paths agree on which cell they are touching.

## 10.5 Google Sheet — the service account (fallback path)

`GOOGLE_SERVICE_ACCOUNT_JSON` holds the whole key JSON on one line; scope
`https://www.googleapis.com/auth/spreadsheets`. The user must share the sheet
with the key's `client_email` as an **Editor**, or every call 403s.

- Read: `spreadsheets.values.get` over the whole tab,
  `valueRenderOption: 'FORMATTED_VALUE'`, `majorDimension: 'ROWS'`.
- Write one cell: `spreadsheets.values.update`, `valueInputOption: 'USER_ENTERED'`.
- Write many (markers, reset): `spreadsheets.values.batchUpdate`.
- If `QUOTA_SHEET_NAME` is unset, `spreadsheets.get` with
  `fields: 'sheets.properties.title'` and take the **first tab**.
- Column letters past Z need a proper base-26 conversion — write the helper,
  don't assume single letters.

## 10.6 Discord webhooks

```
Post   POST  <webhookUrl>?wait=true      → the created message, keep msg.id
Edit   PATCH <webhookUrl-without-query>/messages/<messageId>
```
`?wait=true` is what makes Discord return the message body; without it you get
no id and can never edit the log in place. Strip any existing query string and
trailing slashes off the base URL before appending `/messages/<id>`.

---

# 11. BUILD ORDER (suggested)

1. `prisma/schema.prisma` + `npx prisma migrate dev` — get the data model real first.
2. `lib/actions.js` — the catalog with env getters. Tiny, and everything depends on it.
3. `lib/roblox.js` — identity, CSRF helper, exile, list roles, demote. Test the CSRF retry.
4. `lib/webhook.js` — `buildCaseEmbed`, post, edit. Verify the embed against §1.4 field by field.
5. `lib/quota.js` — sheet read/write, column discovery, row matching, targets, markers, the outbox.
6. `lib/discipline.js` — the approval pipeline, in the order given in §1.3.
7. The expiry worker and the outbox worker; start both from `index.js`.
8. `commands/discipline.js`, `commands/xp.js`, `commands/loa.js`; register them.
9. `scripts/quota-webhook.gs`, `README.md`, `.env.example`, and the env-var table.

## Before you say you are done, verify

- [ ] All 11 actions present, exact names, correct `exile`/`timed` flags.
- [ ] `roleId` is a **getter**, not a value captured at import time.
- [ ] A Supervisor cannot approve a Blacklist or Termination case.
- [ ] Approving twice returns 409; the outbox never double-awards.
- [ ] Exile fires **once per case**, even with two exile-flagged punishments.
- [ ] The embed matches §1.4 exactly — colour, author, `• ` field names, footer,
      and the duration-suffix exceptions.
- [ ] Editing an approved case PATCHes the original message, not a new post.
- [ ] The expiry worker leaves `roleRemoved = false` on failure so it retries.
- [ ] `EX` and `LOA` cells survive `/xp reset` and are never summed.
- [ ] Nothing anywhere is a hard-coded Discord/Roblox/Sheet id.
