# Build Prompt — METAdministration (Discord-only rebuild)

> Paste everything below into a fresh Claude Code session. It is fully
> self-contained: the agent needs no other repository, file or context.
> Fill in the `<<PLACEHOLDERS>>` you already know; all of them are read from
> environment variables at runtime, so they can also be left for the `.env`.

---

## ROLE AND GROUND RULES

You are building **METAdministration**, a Discord bot, from scratch in an empty
directory. Stack: **Node.js 20+, `discord.js` v14, Prisma + PostgreSQL**.

This is a **pure Discord bot**. There is no website, no web server, no Express,
no HTTP API, no browser front-end, no login/OAuth flow, no sessions or JWTs.
Every feature is reached through a **slash command** and answered with a Discord
reply or embed. If you find yourself writing an HTTP route, you have gone wrong.

The bot serves a Roblox law-enforcement roleplay community (the "MET" server).
Staff discipline each other through formal **cases**, and staff earn weekly
**quota points** for the casework they submit.

There is exactly one existing implementation of these systems, and this document
is a complete specification of it. Build exactly what it says.

1. **Do not invent features.** No extra commands, subcommands, options or
   fields. If it is not in this document, it does not exist. Section 7 lists
   commands that are deliberately absent — do not add them.
2. **Do not rename anything.** Action names, embed titles, field labels, log
   lines and error strings are contractual: real people read them. Reproduce
   every quoted string character for character, including emojis, the `• `
   prefixes, and the double space in the boot log line.
3. **Every number is deliberate.** Intervals, point values, retry counts, batch
   sizes, colours and character limits are given explicitly. Use them verbatim.
4. **Fail soft at runtime.** Any Discord, Google or Roblox failure is caught,
   logged, and retried where specified — never crash a command or abort an
   approval halfway. The one exception is boot: a missing *required* env var
   must fail loudly and exit with a clear message.
5. **No hard-coded IDs.** Role, guild, group and sheet IDs and webhook URLs come
   from `process.env`, read **at call time** (not captured at module load), so
   they can change without a redeploy.

### Glossary

| Term | Meaning |
|---|---|
| **Case** | One disciplinary record filed against a staff member; carries one or more punishments. |
| **Subject** | The staff member the case is *against*. The database field is named `officerDiscordId` — keep that name despite the confusion. |
| **Submitter** | The staff member who *filed* the case. This is who earns the points. |
| **IA** | Internal Affairs — the department that files cases. |
| **HICOMM** | High Command, the top permission tier. |
| **Supervisor** | Middle tier: may approve cases, but never Blacklist or Termination. |
| **Quota points** | Points for approved work, tracked per weekday in a Google Sheet. |
| **Exile** | Removing someone from the Roblox group. |
| **LOA** | Leave of Absence — a sheet marker that exempts someone from quota. |
| **IOTW** | Investigator of the Week — a Discord role that lowers its holder's weekly target. |
| **RoVer** | The third-party API linking Discord accounts to Roblox accounts. |

### The whole bot in one paragraph

A staff member runs `/infract file` against someone, picking punishments from
a fixed catalog of eleven. That creates a PENDING case. A reviewer runs
`/infract approve`, and the bot then: posts a formal Administrative Log embed
to a Discord webhook, assigns the Discord role for each punishment, records an
expiry for the timed ones (a background worker strips those roles when they
lapse), removes the subject from the Roblox group if any punishment is
exile-flagged, drops them one Roblox rank on a Demotion, and awards **+4 points
to the filer** — written to a Google Sheet through a durable outbox that retries
until it lands. `/check-record` shows someone's disciplinary history and the
suggested next step. `/xp` reads and administers points. `/loa` writes the
leave-of-absence marker.

---

## THE COMMAND LIST — build these seven, and only these seven

| Command | Subcommands | Who can run it |
|---|---|---|
| `/infract` | `file`, `approve`, `deny`, `lookup` | IA files; Supervisor+ approves/denies |
| `/check-record` | *(none)* | IA and above |
| `/xp` | `me`, `check`, `review`, `reset`, `exempt`, `iotw` | `me` anyone; rest per §3.7 |
| `/loa` | `set` | HICOMM only |
| `/pendingjoin` | `list`, `approve`, `decline` | HICOMM only |
| `/promote` | *(none)* | HICOMM only |
| `/ia` | `case`, `ticket` | IA and above |

---

# 1. `/infract`

## 1.1 The punishment catalog (exact)

Eleven actions, in this exact order, with these exact names. `exile` = also
remove them from the Roblox group. `timed` = accepts a duration in days and
auto-expires.

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

Store this as a single `ACTION_CONFIG` object whose `roleId` is a **getter**
reading `process.env`, so role IDs change without a redeploy. Export
`ACTION_NAMES` in the order above and validate every submitted action against
it, rejecting anything else with `Invalid action: <name>`.

A single case may carry **multiple** punishments at once.

**`Blacklist` and `Termination` are HICOMM-only.** A Supervisor approving a case
containing either gets exactly:
`Only HICOMM can approve a case involving a Blacklist or Termination.`

## 1.2 `/infract file`

Options:
- `subject` (user) — the Discord member the case is against. *Either* this or
  `roblox` is required.
- `roblox` (string) — the subject's Roblox username, for someone not in Discord.
- `reason` (string, required)
- `punishments` (string, required) — the chosen actions. Because Discord has no
  native multi-select on a command option, offer the eleven names via
  **autocomplete** and accept a comma-separated list; validate every entry
  against `ACTION_NAMES`.
- `duration` (integer, optional) — days, applied to the timed punishments in
  this case (`Zero Tolerance`, `Suspension`). Ignored by the rest.
- `notes` (string, optional) — defaults to `N/A`.
- `evidence` (string, optional) — a link.

Behaviour: resolve the subject's Roblox identity at filing time (§8.1), but
never block on it — if RoVer is unavailable, store what you have and carry on;
exile and demotion are simply skipped later. Store the case as `PENDING`, write
a `CaseAction` audit row (`CREATED`, notes `Case submitted`), and reply with the
case ref.

## 1.3 `/infract approve <ref>` — the pipeline, in this exact order

1. Guards: 404-equivalent if no such case; `Case is not pending` if its status
   is not PENDING; the Supervisor + Blacklist/Termination refusal from §1.1.
   Nobody may review their own case.
2. Set `APPROVED`, write a `CaseAction` row (`APPROVED`, notes
   `Approved by HICOMM/Developer`).
3. Fetch the subject's Roblox headshot for the embed thumbnail.
4. If the case was filed Roblox-only, resolve the subject's Discord ID via RoVer
   and **persist it**, so the log can mention them and roles/expiry can apply.
5. Build the action list: `case.actions` when present, else a single entry
   derived from the legacy `case.action` string.
6. **Post the Administrative Log embed** (§1.6) and save the returned message id
   to `case.logMessageId`.
7. For each action with a resolved role (env lookup first, the `roleId`
   snapshotted on the case as fallback): assign the role, then create a
   `CasePunishment` row with
   `expiresAt = durationDays ? now + durationDays*86400000 : null`.
8. **Exile** — if the subject has a Roblox id and any action has `exile: true`,
   call the exile endpoint **once per case**, not once per action. Audit it with
   exactly `Roblox group exile executed for "<Action>" (user <id>)` or
   `Roblox group exile failed for "<Action>" (user <id>)`.
9. **Demotion** — if any action is `Demotion`, drop the subject one Roblox rank
   (§8.3). Audit `Group demotion: <from> → <to> (user <id>)` or
   `Group demotion failed: <reason> (user <id>)`.
10. **Award +4 points** to the member who **filed** the case (never the
    subject), through the outbox in §3.2, label `case #<n>`.

## 1.4 `/infract deny <ref> [note]`

Set `DENIED`, write a `CaseAction` audit row carrying the note. No roles, no
exile, no points, no webhook post.

## 1.5 `/infract lookup <user>`

That member's **approved** case history, and which punishments are still active:
`active = !roleRemoved && (!expiresAt || expiresAt > now)`. List pending and
denied cases separately — only approved ones count toward the record.

## 1.6 The Administrative Log embed (exact)

Posted to a Discord webhook with `?wait=true` so the message id comes back.
**No emojis in this embed** — it is a plain formal notice.

- `content`: `<@officerDiscordId>` when known (this pings the subject)
- `color`: `0x2f3136`
- `title`: `Staff Consequences & Discipline`
- `author.name`: `Signed, Internal Affairs High Command`
- `author.icon_url`: `<<SIGNATURE_ICON_URL>>`
- `thumbnail`: the subject's Roblox headshot when available
- Fields — all `inline: false`, in this order, with the `• ` inside the field
  **name**:
  - `• Staff Member:` → `<@id>`, else
    `[username](https://www.roblox.com/users/<id>/profile)`, else the bare
    username, else the italic literal `*Unknown Officer*`
  - `• Punishment(s):` → the list below
  - `• Reason:` → the reason, or `N/A`
  - `• Notes:` → the notes, or `N/A`
- `footer.text`: `Infraction ID | #<n>` (or `Infraction ID | pending`)
- `timestamp`: ISO now

The punishment list, one bullet per punishment:
```
• Suspension (7d)
• Verbal Warning
• Blacklist
```
Append ` (<n>d)` when `durationDays` is set, otherwise ` (Permanent)` — **except**
`Verbal Warning`, `Termination`, `Demotion` and `Blacklist`, which show no
duration suffix at all when they carry no role.

**Editing an approved case** PATCHes the original message in place
(`PATCH <webhookUrl>/messages/<messageId>`) and retitles it
`Staff Consequences & Discipline (updated)`. If that fails because the message
was deleted, post a fresh one and store the new id.

## 1.7 The timed-punishment expiry worker

- Runs at boot, then **every 5 minutes** (`setInterval(fn, 5 * 60 * 1000)`).
- Finds `CasePunishment` rows where `expiresAt <= now` AND `roleRemoved = false`
  AND `roleId != null`.
- Removes the role in `DISCORD_GUILD_ID`; on success sets `roleRemoved = true`
  and logs `Expired role <roleId> removed from <userId> (#<caseRef>)`.
- A failure leaves `roleRemoved = false`, so the next tick retries — forever.
- It is generic: only `Zero Tolerance` and `Suspension` are timed in practice,
  but anything carrying an `expiresAt` expires.

---

# 2. `/check-record`

One option: `user` — a Discord member **or** a Roblox username (accept both;
decide by whether the input is all digits / a mention).

Identity resolution, in order: RoVer (§8.1) → if that yields nothing, parse the
member's **Discord nickname** in the format `RANK | RobloxUsername` and look the
Roblox username up. If RoVer errored rather than simply finding nothing, say so
in the reply and flag whether it was a rate-limit.

Reply with:
- whether the account is linked; if not, why — `not_linked` for a Discord input,
  `not_found` for a Roblox one
- Roblox username, display name, and whether they are in the group with their
  group rank name
- every **approved** action ever recorded against them, oldest first
- their case history: ref, action, date
- **the suggested next step**, resolved by this ladder, in exactly this
  precedence order — first match wins:

| Already on record | Suggested next | Warning shown |
|---|---|---|
| `Disciplinary Strike 2` | `Termination` | `Existing Disciplinary Strike 2 on record` |
| `Disciplinary Strike 1` | `Disciplinary Strike 2` | `Existing Disciplinary Strike 1 on record` |
| `Activity Strike` | `Disciplinary Strike 1` | `Existing Activity Strike on record` |
| `Written Warning` | `Disciplinary Strike 1` | `Existing Written Warning on record` |
| none of the above | *(nothing suggested)* | *(no warning)* |

---

# 3. `/xp`

## 3.1 Earning

| Event | Points | Label |
|-------|--------|-------|
| Case approved | **+4** | `case #<n>` |
| Ticket approved | **+2** | `ticket TKT-0001` |

Points always go to the **submitter**, never the subject.

## 3.2 The durable outbox — never lose a point

- On approval, `upsert` a `QuotaAward` row keyed `@@unique([refType, refId])`,
  so a re-approve or a retry can **never** double-award. Then kick the processor
  after **50 ms**.
- Worker: `setInterval` every **30 s**, plus a catch-up run **8 s** after boot.
- Each pass takes up to **25** PENDING rows, oldest first.
- Success → `DONE`. Failure → `attempts + 1`; at **40 attempts** mark `FAILED`
  and log exactly:
  `[quota] award <label> FAILED after <n> tries — discord=<id>, roblox=<name>. Add the points manually.`

## 3.3 The sheet

Points live in a Google Sheet: one row per member, one column per weekday.

- **Column discovery is by header text**, scanning every row (headers are not
  necessarily on row 1):
  - username: `username`, `roblox username`, `roblox user`, `roblox`, `user`
  - discord id: `discord id`, `discordid`, `discord`
  - rank: `rank`, `role`
  - days: `sun`…`sat`, the full day names, or any header starting with those
- **Row matching**, in this order: Discord ID exact → Discord ID digits-only →
  Roblox username case-insensitive → Roblox username *normalised* (lowercase,
  strip everything that is not `a-z0-9`, so `Bruh_Lord`, `bruh lord` and
  `bruhlord` all match). Try both the stored username and the live-resolved
  one — people rename.
- Write path: **(1)** a Google Apps Script Web App bound to the sheet
  (`QUOTA_WEBHOOK_URL` + `QUOTA_WEBHOOK_SECRET`) — this is the path that
  actually works; **(2)** fall back to the service account
  (`GOOGLE_SERVICE_ACCOUNT_JSON`) read-modify-writing the single day cell.
- **Serialise writes** through an in-process promise chain: concurrent
  read-modify-writes on one cell silently lose updates.
- "Today" resolves in `QUOTA_TIMEZONE` (default `Europe/London`), never UTC.
- Log every write: `[quota] +<points> <label> → row <r>, <day> = <newValue>`.
- Non-numeric cells (`EX`, `LOA`) are preserved verbatim and never summed.

## 3.4 Weekly targets by rank

Matched case-insensitively against the sheet's rank cell, **in this order**:
```
LOA                                                  → exempt, target 0,  tier "LOA"
/director/                                           → exempt, target 0,  tier "High Command"
/senior\s*investigator|supervisor/                   → target 20,         tier "Middle Command"
/junior\s*investigator|probationary\s*investigator/  → target 30,         tier "Low Command"
anything else / blank                                → target null, tier null (unknown)
```
`remaining = exempt ? 0 : max(0, target - total)`.

## 3.5 Quota reduction role / Investigator of the Week

- A Discord role in `QUOTA_REDUCTION_GUILD_ID` (`QUOTA_REDUCTION_ROLE_ID`)
  lowers its holder's weekly target by `QUOTA_REDUCTION_AMOUNT` (default **10**),
  floored at 0, flagged `reducedBy` so the reply can show it. Exempt members are
  unaffected. Cache role-holder lookups; invalidate the cache on change.
- Setting IOTW makes one user the **exclusive** holder: fetch all guild members,
  remove the role from everyone else, add it to the target. A falsy id clears it
  from everyone.

## 3.6 Rows that are never members

Skip any row whose username or rank matches: `username, roblox username,
roblox user, roblox, user, discord id, discordid, discord, rank, role,
high command, middle command, low command, staff information + quota, total,
warning, strikes, timezone, wtbt`.

## 3.7 Subcommands

- **`/xp me`** — your own points per weekday, total, rank, tier, target,
  `reducedBy`, remaining. Anyone.
- **`/xp check <user>`** — the same for someone else. IA and above.
- **`/xp review`** — build and post the Weekly Quota Review embed (§3.8).
  HICOMM only.
- **`/xp reset`** — HICOMM only. Show a confirmation button first, then clear
  every numeric day cell for member rows. `EX`/`LOA` markers and any formula
  TOTAL column are left untouched. Webhook path first, service account as
  fallback.
- **`/xp exempt <user>`** — write `EX` across that member's day cells.
  HICOMM only.
- **`/xp iotw <user>`** — set the exclusive Investigator of the Week role.
  HICOMM only.

## 3.8 The Weekly Quota Review embed (exact)

Posted to `QUOTA_RESULTS_WEBHOOK_URL` (falling back to the case webhook), with
`content` pinging `<<QUOTA_PING_ROLE_ID>>`:

- `color`: `0x4a8fff`
- `title`: `Weekly Quota Review — <week label>`
- `description`: one line per member —
  `✅ **<username>** · <rank> — <total>/<target> pts` on a pass,
  `❌ **<username>** · <rank> — <total>/<target> pts — <reason, ≤120 chars>` on a
  fail. Exempt members show `Exempt` in place of the points. The Investigator of
  the Week gets ` — ⭐ IOTW` appended. Past 3900 characters, truncate with
  `\n… (list truncated)`.
- Fields, all inline: `Reviewed by` (`<@id>` or name), `Passed`, `Failed`
- `footer.text`: `Internal Affairs · Quota Check`, plus an ISO timestamp

---

# 4. `/loa`

LOA is a **sheet marker**, not a separate table — that is the entire system.

**`/loa set <user>`** — writes the literal `LOA` into every one of that member's
weekday cells. Same two-path write as everything else: the Apps Script webhook
first (`action: 'exempt'`, `marker: 'LOA'`, `username`), service account as
fallback.

- Row lookup for the marker write is by **username, case-insensitive exact**.
- Exact error strings: `No username column found.` when the sheet has no
  username column; `Member not found on the sheet.` when they are not listed;
  `Quota sheet is not configured.` when neither write path is set up.
- A rank cell reading `LOA` makes that member **exempt, target 0, tier "LOA"**
  (§3.4), and LOA counts as a form of exemption in the weekly review.
- `LOA` cells are non-numeric, so §3.3 preserves them and never sums them, and
  `/xp reset` leaves them alone.
- **HICOMM only** — the same gate as `/xp reset`, `/xp exempt` and `/xp iotw`.

---

---

# 5. `/pendingjoin`

Manages the **Roblox group's join requests**. All three subcommands are HICOMM
only, and all need `ROBLOX_GROUP_ID` + `ROBLOX_COOKIE` (§8.3).

- **`/pendingjoin list`** — fetch the pending join requests, 100 per page,
  `sortOrder=Asc`:
  `GET https://groups.roblox.com/v1/groups/<groupId>/join-requests?limit=100&sortOrder=Asc`
  (append `&cursor=<token>` to page). For each request show the Roblox
  **username**, **display name** (falling back to the username when Roblox
  returns none), **user id**, and **requested-at** timestamp. Carry Roblox's
  `nextPageCursor` so a "next page" button or option can continue; treat a
  missing cursor as the end.
- **`/pendingjoin approve <roblox_user_id>`** —
  `POST .../join-requests/users/<userId>`
- **`/pendingjoin decline <roblox_user_id>`** —
  `DELETE .../join-requests/users/<userId>`

Both actions hit the **same URL** and differ only in HTTP method. On a non-OK
response, surface Roblox's own body, truncated to 200 characters, in the form
`Roblox API <status> on <approve|decline>: <body>`. Listing errors read
`Roblox API <status> listing join requests: <body>`. If `ROBLOX_GROUP_ID` is
unset, fail with `ROBLOX_GROUP_ID is not set`.

---

# 6. `/promote`

Changes a member's **Roblox group rank**. HICOMM only.

Options: `user` (the member — accept a Discord user, resolved to Roblox via
§8.1, or a Roblox username) and `rank` (the target rank).

Offer the target ranks through **autocomplete**, sourced live from
`GET https://groups.roblox.com/v1/groups/<groupId>/roles` — which returns
`{ id, name, rank }` per role — sorted ascending by `rank`. Never hard-code a
rank ladder; the group is the source of truth.

Apply with:
```
PATCH https://groups.roblox.com/v1/groups/<groupId>/users/<robloxUserId>
body { roleId: <numeric role id> }
```
Accept a role id given either as a bare number **or** as a full
`groups/<x>/roles/<y>` path — if the value contains a `/`, take the segment
after the last one, then coerce to `Number`. On failure surface
`Roblox API <status> changing rank: <body truncated to 200 chars>`.

This command sets a rank **directly** — it is not the one-step demotion in
§1.3, which is a side effect of a `Demotion` punishment and computes its own
target. Both call the same underlying rank-change endpoint.

The bot's Roblox account needs **Manage lower-ranked member ranks**, and its own
group rank must sit above both the member's current and target ranks.

---

# 7. `/ia` — cases and tickets, reviewed in Discord

The old system reviewed cases and tickets on a website. **There is no website.**
Both are filed with a slash command, posted as an embed into a dedicated
channel, and approved or denied with **buttons on that message**. The channel
message *is* the review queue.

Channels (env-configurable, these are the real ids):
```
IA_GUILD_ID          = 1537076386198716438
CASES_CHANNEL_ID     = 1537076390829101057
TICKETS_CHANNEL_ID   = 1537076390829101058
```

## 7.1 `/ia case` — file a disciplinary case

Same fields and the same eleven-punishment catalog as `/infract file`
(§1.1–§1.2). The difference is **where it goes**: instead of sitting invisibly
in a database as PENDING, the bot posts a **review card** into
`CASES_CHANNEL_ID` and replies to the filer ephemerally with the case ref.

`/infract` and `/ia case` write to the **same `Case` table** and share the
same `CaseCounter`, so refs never collide.

## 7.2 `/ia ticket` — log a ticket

Fields, all matching the old ticket record:
- `roblox` (string, required) — the Roblox username the ticket concerns
- `type` (choice, required) — exactly these four values, no others:
  `GENERAL_SUPPORT`, `HICOMM`, `OFFICER_REPORT`, `APPEAL`
- `conclusion` (string, required) — how the ticket was resolved
- `submitted_at` (string, required) and `timezone` (string, required)
- `transcript` (string, optional) — link
- `proof` (attachment, optional, repeatable up to 3) — store the CDN URLs

Ticket refs are **`TKT-0001`** — the literal prefix `TKT-` and the counter
zero-padded to **4 digits** — from an atomic upsert-increment on
`TicketCounter` id 1, exactly like case refs.

Posts a review card into `TICKETS_CHANNEL_ID`.

## 7.3 The review card

One embed plus one action row: **Approve** (`ButtonStyle.Success`) and **Deny**
(`ButtonStyle.Danger`). Set the button `customId` to
`ia:<case|ticket>:<approve|deny>:<recordId>` so a restart never orphans a
pending card — the handler parses the id out of the button, it holds no state
in memory.

While PENDING:
- `color`: `0xf5b730` (amber)
- `title`: `Case #<n>` or `Ticket TKT-0001`
- Fields: the subject, the punishments (cases) or type and conclusion
  (tickets), the reason, and any evidence or transcript link
- `footer.text`: `Filed by <name>`, with `footer.icon_url` set to the **filer's
  Discord avatar**
- `timestamp`: ISO now

On **Approve**, edit that same message in place — never post a second card:
- `color` → `0x2ed896` (green)
- add a field `• Approved by:` → `<@approverId>`
- set `author.name` → `Approved by <approver display name>` and
  `author.icon_url` → the approver's avatar, from
  `interaction.user.displayAvatarURL({ extension: 'png', size: 64 })`
- **remove the buttons** (`components: []`) so it cannot be actioned twice

On **Deny**: `color` → `0xf04f5e` (red), author line
`Denied by <name>` with the same avatar, buttons removed. Denials award no
points and trigger no roles, exile or demotion.

## 7.4 Who may press the buttons

Approve/Deny are **Supervisor and above**. Enforce it in the interaction
handler, not by hiding the buttons — anyone can click. A non-reviewer gets an
ephemeral `⛔ You are not authorised to review this.`

The §1.1 rules still hold: nobody reviews their own submission, and a
Supervisor pressing Approve on a case containing `Blacklist` or `Termination`
is refused ephemerally with
`Only HICOMM can approve a case involving a Blacklist or Termination.`
`HICOMM`-type **tickets** are High Command only in the same way:
`Only HICOMM can action IA Complaint (HICOMM) tickets.`

A card whose record is no longer PENDING is refused with
`Case is not pending` / `Ticket is not pending`, and its buttons are stripped.

## 7.5 What approval does

**A case** runs the full §1.3 pipeline unchanged — Administrative Log webhook,
roles, expiry rows, once-per-case exile, one-rank demotion — and then awards
**+4**.

**A ticket** does none of that. It sets `APPROVED`, records `reviewedBy` and
`reviewedAt`, and awards **+2**. Nothing else.

## 7.6 Points — one database, two sources

Both awards go through the **same `QuotaAward` outbox and the same Google
Sheet** described in §3.2–§3.3. Nothing about the sheet write differs between
them; only `refType`, `points` and `label` change:

| Source | `refType` | `points` | `label` |
|---|---|---|---|
| Case approved | `'case'` | **4** | `case #<n>` |
| Ticket approved | `'ticket'` | **2** | `ticket TKT-0001` |

The `@@unique([refType, refId])` constraint is what makes this safe: a case and
a ticket can share an id without colliding, and re-pressing Approve can never
double-award. Points always go to the **filer**, never the subject.

For a ticket, resolve the filer's Roblox username for the sheet lookup; if it
is not already cached, do a live RoVer lookup (§8.1) and **cache the result**
back onto their record so the next award is free.

---

# 8. External integrations

## 6.1 Roblox identity (Discord → Roblox)

Primary, with `ROVER_API_KEY`:
```
GET https://registry.rover.link/api/guilds/<DISCORD_GUILD_ID>/discord-to-roblox/<discordUserId>
Authorization: Bearer <ROVER_API_KEY>
→ 200 { robloxId: 123456 }              → String(robloxId)
→ 404                                    → not linked; cache the null
→ body.errorCode === 'user_not_found'    → not linked; cache the null
→ 429                                    → trip the cooldown (below), return cached/null
```
Public fallback when no key is configured (rate-limited — warn about it):
`GET https://verify.eryn.io/api/user/<discordUserId>`.

**Resolution order, and it matters:** in-memory cache (TTL ~30 min) → the Roblox
id already stored on that user's row in your own database → RoVer. Checking your
own DB before RoVer is what keeps the bot off the rate limit.

**The 429 cooldown**: on a 429, set `roverCooldownUntil` from the response's
`detail.retryAfter` (default a few minutes) and, while it holds, **do not call
RoVer at all** — serve the cached or stored value, or null. Retrying into a
rate-limit extends the ban and stalls approvals. A missing Roblox link is never
an error: exile and demotion are just skipped.

## 6.2 Roblox reads (public, no auth)

```
Headshot   GET https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=<id>&size=150x150&format=Png&isCircular=false
           → data[0].imageUrl
Membership GET https://groups.roblox.com/v2/users/<id>/groups/roles
           → data[] — find the entry whose group.id === ROBLOX_GROUP_ID
             → { group, role: { id, name, rank } }
```

## 6.3 Roblox writes (authenticated)

All writes go through one `robloxAuthFetch(url, options, allowRetry = true)`:

- Headers: `Cookie: .ROBLOSECURITY=<ROBLOX_COOKIE>`,
  `Content-Type: application/json`, plus `X-CSRF-TOKEN` when one is cached.
- **On a 403, Roblox returns a fresh token in the `x-csrf-token` response
  header.** Capture it and retry once with `allowRetry = false`. Without this,
  every write fails.
- Warm the token at boot with a throwaway
  `POST https://auth.roblox.com/v2/logout` — its own failure is irrelevant, you
  only want the header — so the first real action does not pay for the retry.

```
Exile        DELETE https://groups.roblox.com/v1/groups/<groupId>/users/<userId>
List ranks   GET    https://groups.roblox.com/v1/groups/<groupId>/roles
                    → roles[] of { id, name, rank }, sorted ascending by rank
Change rank  PATCH  https://groups.roblox.com/v1/groups/<groupId>/users/<userId>
                    body { roleId: <target role id> }
```

**Demotion algorithm**: read the subject's current `rank`; from the group's
roles take every role with `rank > 0` **and** `rank < currentRank`; pick the
**highest** of those; set it. The `rank > 0` test excludes the guest role. If
nothing qualifies, fail with the reason `already at the lowest rank`.

If `ROBLOX_GROUP_ID` or `ROBLOX_COOKIE` is unset, log
`Group exile skipped — ROBLOX_GROUP_ID or ROBLOX_COOKIE not set.` and carry on.
Never throw.

Roblox group permissions the bot's Roblox account needs: **Remove Members** for
exile, **Manage lower-ranked member ranks** for demotion — and its own group
rank must sit **above** everyone it acts on.

## 6.4 The Google Sheet — Apps Script web app (primary write path)

Ship a `scripts/quota-webhook.gs` for the user to paste into their sheet
(Extensions → Apps Script → Deploy → Web app, *Execute as: Me*, *Who has access:
Anyone*). The resulting `/exec` URL becomes `QUOTA_WEBHOOK_URL`.

The bot POSTs JSON, always with `redirect: 'follow'` (Apps Script 302s):
```jsonc
{ "secret": "<QUOTA_WEBHOOK_SECRET>", "action": "add",    "username": "...", "discordId": "...", "points": 4 }
{ "secret": "<QUOTA_WEBHOOK_SECRET>", "action": "exempt", "username": "...", "marker": "EX" }   // or "LOA"
{ "secret": "<QUOTA_WEBHOOK_SECRET>", "action": "reset" }
```
Responses: `{ ok: true, row, day, newValue }` / `{ ok: true, cleared }` /
`{ ok: false, error }`. A wrong secret returns
`{ ok: false, error: 'bad secret' }`.

The script must:
- Verify the secret before doing anything.
- **Take a `LockService.getScriptLock()` with `waitLock(30000)` around the whole
  handler**, and `SpreadsheetApp.flush()` before releasing. Two approvals
  landing together would otherwise each read the old cell value and write back
  `old + points`, silently losing one increment. On lock timeout return
  `{ ok: false, error: 'busy — could not acquire lock' }`.
- Resolve "today" in its own `TIMEZONE` constant (`Europe/London`).
- Use the same header-detection and row-matching rules as §3.3, so both write
  paths agree on which cell they touch.

## 6.5 The Google Sheet — service account (fallback path)

`GOOGLE_SERVICE_ACCOUNT_JSON` holds the entire key JSON on one line; scope
`https://www.googleapis.com/auth/spreadsheets`. The sheet must be shared with
the key's `client_email` as an **Editor**, or every call 403s.

- Read: `spreadsheets.values.get` over the whole tab,
  `valueRenderOption: 'FORMATTED_VALUE'`, `majorDimension: 'ROWS'`.
- Write one cell: `spreadsheets.values.update`,
  `valueInputOption: 'USER_ENTERED'`.
- Write many (markers, reset): `spreadsheets.values.batchUpdate`.
- When `QUOTA_SHEET_NAME` is unset, call `spreadsheets.get` with
  `fields: 'sheets.properties.title'` and take the **first tab**.
- Column letters past Z need real base-26 conversion — write the helper, do not
  assume single letters.

## 6.6 Discord webhooks

```
Post   POST  <webhookUrl>?wait=true      → the created message; keep msg.id
Edit   PATCH <webhookUrl-without-query>/messages/<messageId>
```
`?wait=true` is what makes Discord return the message body; without it there is
no id and the log can never be edited in place. Strip any existing query string
and trailing slashes from the base URL before appending `/messages/<id>`.

---

# 9. Explicitly out of scope

## 7.1 Commands that must NOT exist

The old system had a companion website. **Do not** rebuild any of it, and do not
add commands for it. In particular, do not create: `/promote`, `/ia`, `/met`,
`/loa request`, `/loa history`, `/loa admin`, `/tryout`, `/exam`, `/ticket`,
`/penal`, `/offence`, `/import-cases`, or any command for divisions (CID,
SCO-19, FLP, HPC), tryouts, exams, tickets, penal-code or offence lookups,
media, or push notifications. **`/import-cases` in particular belongs to the
separate IA server and must not be built here** — this bot is for the MET
server only. If you think one is needed, stop and say so instead of building
it.

Tickets **do** exist — see §7 — so points come from two sources: +4 on a case
approval and +2 on a ticket approval, both into the same `QuotaAward` table.

## 7.2 Bot mechanics

- Intents: `Guilds` and `GuildMembers` only. Do **not** request the privileged
  `MessageContent` intent — nothing in this bot reads message content. Still
  guard the login: if it fails, log the reason clearly rather than crashing.
- Boot log line, exactly: ``🤖  Discord bot online as <tag>`` (two spaces).
- Guard every guild/member/role call: not ready → warn and return false, never
  throw. Log `Role <id> assigned to <user>` and `Role <id> removed from <user>`,
  and `Failed to assign role <id> to <user>: <msg>` on failure.
- Defer any reply that might take time. `✅` for success, `❌ <message>` for
  failure, `⛔` for authorisation refusals.

---

# 10. Data model (Prisma)

```prisma
enum CaseStatus { PENDING APPROVED DENIED }

model Case {
  id               String     @id @default(uuid())
  caseRef          String     @unique     // "#1", "#2", … sequential
  submitterDiscordId String                // who FILED it — earns the points
  officerDiscordId String?                // the SUBJECT
  robloxUserId     String?
  robloxUsername   String?
  action           String                 // display string: "Suspension, Demotion"
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
  performedBy String   // Discord user id
  notes       String?
  createdAt   DateTime @default(now())
}

model CaseCounter   { id Int @id @default(1)  count Int @default(0) }
model TicketCounter { id Int @id @default(1)  count Int @default(0) }

enum TicketType   { GENERAL_SUPPORT HICOMM OFFICER_REPORT APPEAL }
enum TicketStatus { PENDING APPROVED DENIED }

model Ticket {
  id               String       @id @default(uuid())
  ticketRef        String       @unique     // "TKT-0001"
  filerDiscordId   String                   // who logged it — earns the +2
  robloxUsername   String
  ticketType       TicketType
  submittedAt      String
  timezone         String
  conclusion       String
  transcriptLink   String?
  proofImages      Json?
  logMessageId     String?                  // the review card in TICKETS_CHANNEL_ID
  status           TicketStatus @default(PENDING)
  reviewedBy       String?                  // Discord user id
  reviewedAt       DateTime?
  createdAt        DateTime     @default(now())
}

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

**Case refs**: an atomic upsert-increment on `CaseCounter` id 1, formatted
`#<count>`. Never random, never reused.

Note there is no `User` table: this bot has no accounts or logins. Identity is
the Discord user id, and the Roblox link is resolved live and cached.

---

# 11. Permissions

Resolved from Discord roles in `DISCORD_GUILD_ID`, checked at call time:
```
ROLE_IA              = <<STAFF_ROLE_ID>>          # file cases, /check-record, /xp check
ROLE_SUPERVISOR      = <<SUPERVISOR_ROLE_ID>>     # approve/deny — NOT Blacklist/Termination
ROLE_HICOMM          = <<HIGH_COMMAND_ROLE_ID>>   # approve anything; /xp review|reset|exempt|iotw; /loa
DEVELOPER_DISCORD_ID = <<YOUR_DISCORD_USER_ID>>   # always full access, every command
DEVELOPER_ROLE_ID    = <<OPTIONAL_ROLE_ID>>
```
Nobody may review their own case.

---

# 12. Build order

1. `prisma/schema.prisma` + `npx prisma migrate dev` — make the data model real first.
2. `lib/actions.js` — the catalog with env getters. Tiny, and everything depends on it.
3. `lib/roblox.js` — identity, the CSRF helper, exile, list roles, demote,
   change rank, list/resolve join requests. Test the CSRF retry.
4. `lib/webhook.js` — `buildCaseEmbed`, post, edit. Check the embed against §1.6 field by field.
5. `lib/quota.js` — sheet read/write, column discovery, row matching, targets, markers, the outbox.
6. `lib/infract.js` — the approval pipeline, in the order given in §1.3.
7. The expiry worker and the outbox worker; start both from `index.js`.
8. `commands/infract.js`, `commands/check-record.js`, `commands/xp.js`,
   `commands/loa.js`, `commands/pendingjoin.js`, `commands/promote.js`,
   `commands/ia.js`; register them, plus the button handler for the review
   cards (`lib/reviewCard.js`).
9. `scripts/quota-webhook.gs`, `README.md`, `.env.example`, and the env-var table.

## Before you call it done, verify

- [ ] Exactly seven commands registered — no others.
- [ ] All 11 actions present, exact names, correct `exile`/`timed` flags.
- [ ] `roleId` is a **getter**, not a value captured at import time.
- [ ] A Supervisor cannot approve a Blacklist or Termination case.
- [ ] Approving twice is refused; the outbox never double-awards.
- [ ] Exile fires **once per case**, even with two exile-flagged punishments.
- [ ] The embed matches §1.6 exactly — colour, author, `• ` field names, footer,
      and the duration-suffix exceptions.
- [ ] Editing an approved case PATCHes the original message, not a new post.
- [ ] The expiry worker leaves `roleRemoved = false` on failure so it retries.
- [ ] `/check-record`'s suggestion ladder resolves in the §2 precedence order.
- [ ] `/promote`'s rank autocomplete is read live from the group, not hard-coded.
- [ ] `/pendingjoin approve` and `decline` hit the same URL, differing only in
      HTTP method (POST vs DELETE).
- [ ] Review-card buttons carry the record id in their `customId`, so a restart
      does not orphan pending cards.
- [ ] Approving edits the original card in place and strips its buttons; it
      never posts a second card.
- [ ] The approver's avatar shows on the card via `displayAvatarURL()`.
- [ ] A case awards 4 and a ticket 2, into the same `QuotaAward` table, and
      re-pressing Approve cannot double-award.
- [ ] `EX` and `LOA` cells survive `/xp reset` and are never summed.
- [ ] No Express, no HTTP routes, no web server anywhere.
- [ ] Nothing is a hard-coded Discord, Roblox or Sheet id.

---

# 13. Deliverables

1. The bot: `index.js`, `lib/actions.js`, `lib/infract.js`, `lib/quota.js`,
   `lib/roblox.js`, `lib/webhook.js`, `commands/*.js`, `prisma/schema.prisma`,
   and `scripts/quota-webhook.gs`.
2. A `README.md`: creating the bot application, enabling the Server Members
   intent, inviting it with Manage Roles (its role
   must sit **above** every punishment role), the Google service account and
   sharing the sheet with its `client_email`, and deploying the Apps Script.
3. **A complete `.env.example` and a plain-English table of every environment
   variable** — name, what it is, exactly where to get the value, and required
   vs optional — grouped as Core, Discord, Roles, Roblox, Google/Quota,
   Webhooks. State which Roblox group permissions the exile and rank-change
   features need.
