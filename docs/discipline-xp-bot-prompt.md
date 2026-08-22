# Build Prompt — MET Discipline & Quota-Points ("XP") Discord Bot

> Copy everything below the line into a fresh Claude Code / AI session.
> Fill in every `<<PLACEHOLDER>>` first (or leave them — the bot must read them
> all from env vars and refuse to start with a clear message if a required one
> is missing).

---

## ROLE

You are building a **standalone Discord bot** (Node.js 20+, `discord.js` v14,
Prisma + PostgreSQL) that reproduces, exactly, the discipline (punishment) and
quota-points ("XP") systems of an existing law-enforcement roleplay community
portal. Everything below is the specification. Do not invent extra features, do
not rename anything, do not simplify any rule. Where a number, emoji, colour,
string or interval is given, use it verbatim.

At the very end of your work you MUST print a complete `.env.example` and a
plain-English list of every environment variable I have to set, what it is,
where to get it, and whether it is required or optional.

---

## 1. HIGH-LEVEL SHAPE

Two coupled systems:

1. **Discipline / Punishments** — an infraction ("case") is filed against a
   member, reviewed, and on approval the bot: posts an Administrative Log
   embed, assigns Discord punishment roles, schedules automatic role removal
   for timed punishments, exiles the member from the Roblox group for
   exile-flagged punishments, and demotes them one Roblox rank for a Demotion.
2. **Quota Points ("XP")** — staff earn points for approved work (+4 a case,
   +2 a ticket), tracked per weekday in a Google Sheet, with per-rank weekly
   targets, exemptions, a quota-reduction role, a weekly review post and a
   weekly reset.

Both must be **fail-soft**: a Google/Roblox/Discord failure is logged and
retried, never crashes the approval flow.

---

## 2. PUNISHMENT CATALOG (exact)

Eleven actions, in this exact order and with these exact names. Each has an
optional Discord role, an `exile` flag (removes them from the Roblox group)
and a `timed` flag (accepts a duration in days and auto-expires).

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

Implementation rules:
- Store this as a single `ACTION_CONFIG` object whose `roleId` is a **getter**
  that reads `process.env` at call time (so role IDs can change without a
  redeploy and without restarting).
- Export `ACTION_NAMES` (the key order above) and
  `roleIdForAction(action)` helpers. Every action list the bot accepts must be
  validated against `ACTION_NAMES` — reject anything else with
  `Invalid action: <name>`.
- A single case may carry **multiple** punishments at once (an array).
- `Blacklist` and `Termination` are **High Command only**: a Supervisor-tier
  reviewer may not approve a case containing either. Error message:
  `Only HICOMM can approve a case involving a Blacklist or Termination.`

### Placeholders to fill
```
DISCORD_GUILD_ID           = <<MAIN_DISCORD_SERVER_ID>>
ROLE_VERBAL_WARNING        = <<ROLE_ID>>
ROLE_WRITTEN_WARNING       = <<ROLE_ID>>
ROLE_ZT                    = <<ROLE_ID>>
ROLE_SUSPENDED             = <<ROLE_ID>>
ROLE_ACTIVITY_STRIKE       = <<ROLE_ID>>
ROLE_STRIKE_1              = <<ROLE_ID>>
ROLE_STRIKE_2              = <<ROLE_ID>>
ROLE_STRIKE_3              = <<ROLE_ID>>
ROLE_BLACKLIST             = <<ROLE_ID>>
```

---

## 3. DATA MODEL (Prisma)

```prisma
enum CaseStatus { PENDING APPROVED DENIED }

model Case {
  id               String     @id @default(uuid())
  caseRef          String     @unique     // "#1", "#2", … sequential
  userId           String                 // the staff member who FILED it
  officerDiscordId String?                // the SUBJECT's Discord id
  robloxUserId     String?                // the SUBJECT's Roblox id
  robloxUsername   String?
  action           String                 // display string: "Suspension, Demotion"
  actions          Json?                  // [{ action, roleId, durationDays }]
  reason           String
  notes            String     @default("N/A")
  caseLink         String?                // evidence / document link
  investigatorRobloxId        String?
  investigatorRobloxUsername  String?
  investigatorDiscordUsername String?
  suspectRobloxDisplayName    String?
  punishmentsSummary          String?
  logMessageId     String?                // webhook message id, for in-place edits
  reviewNote       String?
  reviewChanges    Json?
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

model CaseAction {          // full audit trail
  id          String   @id @default(uuid())
  caseId      String
  actionType  String   // CREATED | APPROVED | DENIED | EDITED | CHANGES_REQUESTED
  performedBy String
  notes       String?
  createdAt   DateTime @default(now())
}

model CaseCounter { id Int @id @default(1)  count Int @default(0) }

model QuotaAward {          // durable points outbox
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

**Case reference generation** — atomic upsert-increment on `CaseCounter` id 1,
formatted as `#<count>`. Never random, never reused.

---

## 4. THE APPROVAL PIPELINE (order matters — implement exactly)

When a pending case is approved:

1. Guard: 404 if not found; `409 Case is not pending` if status ≠ PENDING;
   403 if a Supervisor tries to approve a Blacklist/Termination case.
2. Set `status = APPROVED`, write a `CaseAction` row
   (`actionType: 'APPROVED'`, notes `Approved by HICOMM/Developer`).
3. Fetch the subject's **Roblox headshot** for the embed thumbnail.
4. If the case was filed with only a Roblox identity, resolve the subject's
   Discord ID (via the Roblox↔Discord verification API) and **persist** it, so
   the log can mention them and roles/expiry can apply.
5. Build the action list: `case.actions` if present, else a single-element list
   from the legacy `case.action` field.
6. **Post the Administrative Log webhook** (section 5) and save the returned
   message id to `case.logMessageId`.
7. **For each action with a resolved role** (env lookup first, snapshotted
   `a.roleId` as fallback): assign the Discord role, then create a
   `CasePunishment` row with
   `expiresAt = durationDays ? now + durationDays*86400000 : null`.
8. **Exile**: if the subject has a Roblox id and any action has `exile: true`,
   call `DELETE /v1/groups/{groupId}/users/{userId}` **once per case** (not per
   action). Log a `CaseAction` recording success or failure with the exact text
   `Roblox group exile executed for "<Action>" (user <id>)` /
   `Roblox group exile failed for "<Action>" (user <id>)`.
9. **Demotion**: if any action is `Demotion`, drop the subject **one rank** in
   the Roblox group — list group roles, take all roles with `rank > 0` and
   `rank < currentRank`, pick the highest of those, set it. Log
   `Group demotion: <from> → <to> (user <id>)` or
   `Group demotion failed: <reason> (user <id>)`.
10. **Award +4 quota points** to the staff member who FILED the case (not the
    subject), via the durable outbox, label `case #<n>`. Skip entirely if the
    filer is the system import account (`SYSTEM_LEGACY_IMPORT`).

**Editing an approved case** must PATCH the original webhook message in place
(`PATCH <webhookUrl>/messages/<messageId>`) and retitle it
`Staff Consequences & Discipline (updated)`. If the edit fails (message
deleted), post a fresh one and store the new id.

---

## 5. THE ADMINISTRATIVE LOG EMBED (exact)

Posted to a Discord webhook, `?wait=true` so the message id comes back.

- `content`: `<@officerDiscordId>` (ping the subject) when known.
- `color`: `0x2f3136`
- `title`: `Staff Consequences & Discipline`
  (`Staff Consequences & Discipline (updated)` on edit)
- `author.name`: `Signed, Internal Affairs High Command`
  `author.icon_url`: `<<SIGNATURE_ICON_URL>>`
- `thumbnail`: the subject's Roblox headshot, when available.
- Fields (all `inline: false`, in this order, with the leading `• ` in the
  field **name**):
  - `• Staff Member:` → `<@id>`, else `[username](https://www.roblox.com/users/<id>/profile)`,
    else the bare username, else the italic literal `*Unknown Officer*`
  - `• Punishment(s):` → the punishment list (below)
  - `• Reason:` → reason or `N/A`
  - `• Notes:` → notes or `N/A`
- `footer.text`: `Infraction ID | #<n>` (or `Infraction ID | pending`)
- `timestamp`: ISO now.

**Punishment list formatting** — one bullet per punishment:
```
• Suspension (7d)
• Verbal Warning
• Blacklist
```
Rule: append ` (<n>d)` when `durationDays` is set, otherwise ` (Permanent)`;
**except** `Verbal Warning`, `Termination`, `Demotion` and `Blacklist`, which
show no duration suffix at all when they carry no role.

---

## 6. TIMED PUNISHMENT EXPIRY (background worker)

- Runs on boot and then **every 5 minutes** (`setInterval(..., 5 * 60 * 1000)`).
- Query: `CasePunishment` where `expiresAt <= now` AND `roleRemoved = false`
  AND `roleId != null`.
- For each: remove the role from the subject in `DISCORD_GUILD_ID`; on success
  set `roleRemoved = true` and log
  `Expired role <roleId> removed from <userId> (#<caseRef>)`.
- A failure must leave `roleRemoved = false` so the next tick retries forever.
- Only `Zero Tolerance` and `Suspension` are timed in practice, but the worker
  is generic — anything with an `expiresAt` expires.

---

## 7. QUOTA POINTS ("XP") SYSTEM

### 7.1 Earning
| Event | Points | Label |
|-------|--------|-------|
| Case approved | **+4** | `case #<n>` |
| Ticket log approved | **+2** | `ticket <ref>` |

Points always go to the **submitter**, never the subject.

### 7.2 Durable outbox (never lose a point)
- On approval, `upsert` a `QuotaAward` keyed `@@unique([refType, refId])` —
  so re-approving or retrying can **never** double-award.
- Then kick the processor after **50 ms**.
- Worker: `setInterval` every **30 s**, plus a catch-up run **8 s** after boot.
- Each pass takes up to **25** PENDING rows, oldest first.
- On success → `DONE`. On failure → `attempts + 1`; at **40 attempts** mark
  `FAILED` and log
  `[quota] award <label> FAILED after <n> tries — discord=<id>, roblox=<name>. Add the points manually.`

### 7.3 The sheet
Points live in a Google Sheet, one row per member, one column per weekday.

- Column discovery is **by header text**, scanning all rows (headers may not be
  row 1):
  - username: `username`, `roblox username`, `roblox user`, `roblox`, `user`
  - discord id: `discord id`, `discordid`, `discord`
  - rank: `rank`, `role`
  - days: `sun`…`sat`, or full day names, or any header starting with those.
- **Row matching**, in this order: Discord ID exact → Discord ID digits-only →
  Roblox username case-insensitive exact → Roblox username *normalised*
  (lowercase, strip everything that isn't `a-z0-9`, so `Bruh_Lord`,
  `bruh lord` and `bruhlord` all match). Try both the stored username and the
  live-resolved current username — people rename.
- Write path priority: **(1)** a Google Apps Script Web App bound to the sheet
  (`QUOTA_WEBHOOK_URL` + `QUOTA_WEBHOOK_SECRET`) — this is the path that
  actually works reliably; **(2)** fall back to the service account
  (`GOOGLE_SERVICE_ACCOUNT_JSON`, scope
  `https://www.googleapis.com/auth/spreadsheets`) doing read-modify-write on
  the single day cell.
- Serialise writes through an in-process promise chain — concurrent
  read-modify-writes on the same cell cause lost updates.
- "Today" is resolved in `QUOTA_TIMEZONE` (default `Europe/London`), not UTC.
- Log every write: `[quota] +<points> <label> → row <r>, <day> = <newValue>`.
- Non-numeric cells (`EX`, `LOA`) are preserved verbatim and never summed.

### 7.4 Weekly targets by rank
```
LOA                                             → exempt, target 0,  tier "LOA"
/director/                                      → exempt, target 0,  tier "High Command"
/senior\s*investigator|supervisor/              → target 20,         tier "Middle Command"
/junior\s*investigator|probationary\s*investigator/ → target 30,     tier "Low Command"
anything else / blank                           → target null, tier null (unknown)
```
Match case-insensitively against the sheet's rank cell, in exactly that order.
`remaining = exempt ? 0 : max(0, target - total)`.

### 7.5 Quota reduction role / Investigator of the Week
- A Discord role in `QUOTA_REDUCTION_GUILD_ID` (`QUOTA_REDUCTION_ROLE_ID`)
  reduces the holder's weekly target by `QUOTA_REDUCTION_AMOUNT` (default
  **10**), floored at 0, and the result is flagged `reducedBy` so the UI can
  show it. Exempt members are unaffected.
- Role-holder lookups are cached (a short TTL is fine); the cache is
  invalidated whenever the holder changes.
- **Set Investigator of the Week** makes one user the *exclusive* holder of
  that role: fetch all guild members, remove the role from everyone else, add
  it to the target. Passing a falsy id clears it from everyone.

### 7.6 Weekly review + reset
- `resetAllQuota()` clears every numeric day cell for member rows; `EX`/`LOA`
  markers and any formula TOTAL column are left untouched. Webhook path first,
  service account as fallback.
- `setMemberExempt(username)` writes `EX` across the member's day cells;
  `setMemberLOA(username)` writes `LOA`.
- Rows whose username or rank matches any of these are **never** members and
  are skipped: `username, roblox username, roblox user, roblox, user,
  discord id, discordid, discord, rank, role, high command, middle command,
  low command, staff information + quota, total, warning, strikes, timezone,
  wtbt`.

### 7.7 Weekly Quota Review embed (exact)
Posted to `QUOTA_RESULTS_WEBHOOK_URL` (falling back to the case webhook), with
`content` pinging `<<QUOTA_PING_ROLE_ID>>`:

- `color`: `0x4a8fff`
- `title`: `Weekly Quota Review — <week label>`
- `description`: one line per member —
  `✅ **<username>** · <rank> — <total>/<target> pts` for a pass,
  `❌ **<username>** · <rank> — <total>/<target> pts — <reason, ≤120 chars>` for a fail.
  Exempt members show `Exempt` instead of the points. The Investigator of the
  Week gets ` — ⭐ IOTW` appended.
  Truncate the description past 3900 chars with `\n… (list truncated)`.
- Fields (all inline): `Reviewed by` (`<@id>` or name), `Passed` (count),
  `Failed` (count).
- `footer.text`: `Internal Affairs · Quota Check`, plus an ISO timestamp.

---

## 8. ROBLOX INTEGRATION

- **Identity**: resolve Discord ↔ Roblox through the verification API
  (`ROVER_API_KEY`), with a stored fallback and a **cooldown/backoff on 429s**
  so a rate-limit never stalls approvals. Cache group-role lookups ~30 minutes.
- **Group actions** need the `.ROBLOSECURITY` cookie (`ROBLOX_COOKIE`) with
  X-CSRF-TOKEN handling: seed the token from a throwaway authed request and
  transparently re-fetch + retry once on a 403 token mismatch.
  - Exile: `DELETE https://groups.roblox.com/v1/groups/<groupId>/users/<userId>`
  - List ranks / change rank for demotion.
- If `ROBLOX_GROUP_ID` or `ROBLOX_COOKIE` is unset, log
  `Group exile skipped — ROBLOX_GROUP_ID or ROBLOX_COOKIE not set.` and carry
  on. Never throw.
- Headshot for the embed thumbnail comes from the Roblox thumbnails API.

---

## 9. PENAL CODES / OFFENCE CATALOG

Both read a **public Google Sheet CSV export**
(`https://docs.google.com/spreadsheets/d/<id>/export?format=csv`) with a
hand-rolled CSV parser that handles quoted fields, embedded commas and `""`
escapes. Do not add a CSV dependency.

- `resolveCode(code)` → `{ code, offense, class }`, cached **30 minutes**,
  tolerant of whitespace/dash variants; `resolveCodes([...])` preserves input
  order and marks unresolved entries `found: false` with empty offense/class.
- `getActiveOffenses()` → the catalog, cached **1 hour**, header-driven column
  detection (`penal`/`code`, `offense`/`offence`, `class`,
  `defin`/`definition`/`oversimplified`, `status`/`active`), **skipping any row
  whose status does not start with `active`**.
- A failed fetch returns the stale cache rather than an error, and the
  offence-sheet error message is:
  `Could not read the offence sheet (is it shared "anyone with the link can view"?).`

---

## 10. DISCORD BOT MECHANICS

- Intents: `Guilds`, `GuildMembers` always. Request the **privileged**
  `GuildMessages` + `MessageContent` intents only when a message-reading
  feature is configured — and if login fails because the portal hasn't enabled
  them, **transparently retry the login without them** so role assignment and
  expiry keep working. Never let that take the bot offline.
- Ready log line, exactly: ``🤖  Discord bot online as <tag>`` (two spaces).
- Guard every guild/member/role call: not-ready → warn and return false, never
  throw. Log
  `Role <id> assigned to <user>` / `Role <id> removed from <user>` and
  `Failed to assign role <id> to <user>: <msg>` on failure.

### Slash commands to implement
- `/case-file` — subject (user or Roblox username), reason, notes, evidence
  link, and a multi-select of punishments with an optional duration in days per
  timed punishment. Creates a PENDING case, replies with the case ref.
- `/case-approve <ref>` / `/case-deny <ref> [note]` — reviewer-gated (see §11),
  runs the full §4 pipeline.
- `/case-lookup <user>` — that member's approved case history + which
  punishments are still active
  (`active = !roleRemoved && (!expiresAt || expiresAt > now)`), plus the
  pending/denied ones listed separately (approved cases alone count toward
  the record).
- `/quota me` and `/quota check <user>` — points per weekday, total, rank,
  tier, target, `reducedBy`, remaining.
- `/quota review` — build and post the Weekly Quota Review embed (§7.7).
- `/quota reset` — HICOMM only, confirmation button, then `resetAllQuota()`.
- `/quota exempt <user>` / `/quota loa <user>` — write `EX` / `LOA`.
- `/iotw <user>` — set the exclusive Investigator of the Week role.
- `/penal <code>` — look up a penal code.
Reply to long-running commands **immediately** (defer) so the interaction
token never expires. Use `✅` for success replies and `❌ <message>` for
failures, matching the existing style.

---

## 11. PERMISSIONS

Three reviewer tiers, resolved from Discord roles:
```
ROLE_IA          = <<STAFF_ROLE_ID>>          # can file cases/tickets
ROLE_SUPERVISOR  = <<SUPERVISOR_ROLE_ID>>     # can approve, EXCEPT Blacklist/Termination
ROLE_HICOMM      = <<HIGH_COMMAND_ROLE_ID>>   # can approve anything, reset quota, set IOTW
DEVELOPER_DISCORD_ID = <<YOUR_DISCORD_USER_ID>>   # always full access
DEVELOPER_ROLE_ID    = <<OPTIONAL_ROLE_ID>>
```
A member may not review their own case.

---

## 12. NON-NEGOTIABLES

- Every external call (Discord, Google, Roblox) is wrapped: log and continue,
  never crash an approval.
- Role IDs, group IDs, webhook URLs, sheet IDs: **env vars only**, read at call
  time. No hard-coded IDs anywhere in the source.
- Idempotency: one award per case/ticket ever; one exile per case; approving
  twice is a `409`.
- Full audit trail — every state change writes a `CaseAction` row.
- Fail loudly at **boot** (clear message, exit) if a required env var is
  missing; fail soft at runtime for everything optional.

---

## 13. DELIVERABLES

1. The working bot: `index.js`, `lib/actions.js`, `lib/discipline.js`,
   `lib/quota.js`, `lib/roblox.js`, `lib/penalCodes.js`, `lib/webhook.js`,
   `commands/*`, `prisma/schema.prisma`, plus the Apps Script
   (`scripts/quota-webhook.gs`) for the sheet write path.
2. A `README.md` with setup steps: creating the bot, which privileged intents
   to enable, inviting it with the right permissions (Manage Roles, and the bot
   role must sit **above** every punishment role), the Google service account +
   sharing the sheet with its `client_email`, and deploying the Apps Script.
3. **Finally: print a complete `.env.example` and then a plain-English table of
   every environment variable — name, what it is, exactly where I get the
   value, and required vs optional.** Group them: Core, Discord, Roles, Roblox,
   Google/Quota, Webhooks, Optional. I will be adding the bot accounts to the
   Roblox groups myself, so tell me clearly which group permissions each
   Roblox-side feature needs (exile, rank change).
