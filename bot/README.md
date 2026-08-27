# METAdministration

MET server Discord bot: discipline, quota points, LOA, Roblox group admin, and
IA cases/tickets. Everything happens through slash commands — there is no
website, no HTTP server, and nothing to host beyond the bot process itself.

## Commands

| Command | Subcommands | Who |
|---|---|---|
| `/discipline` | `file` `approve` `deny` `lookup` | IA files · Supervisor+ reviews |
| `/check-record` | — | IA+ |
| `/xp` | `me` `check` `review` `reset` `exempt` `iotw` | `me` anyone · `check` IA+ · rest HICOMM |
| `/loa` | `set` | HICOMM |
| `/pendingjoin` | `list` `approve` `decline` | HICOMM |
| `/promote` | — | HICOMM |
| `/ia` | `case` `ticket` | IA+ files · Supervisor+ reviews via buttons |

### How discipline works

`/discipline file` (or `/ia case`) creates a PENDING case and posts a **review
card** into the cases channel with Approve / Deny buttons. On approval the bot,
in order: posts the Administrative Log notice to the webhook, assigns each
punishment's Discord role, records expiry rows for timed ones, exiles the
subject from the Roblox group once if any punishment is exile-flagged, drops
them one rank on a `Demotion`, and awards **+4 quota points to whoever filed
it**. Approved tickets award **+2**. Both go through the same durable outbox
into the same Google Sheet.

Timed punishments (`Zero Tolerance`, `Suspension`) expire on their own: a worker
runs every 5 minutes and removes the role. A failed removal is retried forever
rather than being marked done.

## Setup

### 1. The Discord application
1. https://discord.com/developers/applications → New Application.
2. **Bot** → Reset Token → copy into `DISCORD_BOT_TOKEN`.
3. **Bot → Privileged Gateway Intents** → enable **Server Members Intent**.
   (Message Content is *not* needed — the bot never reads message content.)
4. **General Information** → copy the Application ID into `DISCORD_CLIENT_ID`.
5. **OAuth2 → URL Generator** → scopes `bot` + `applications.commands`,
   bot permissions: **Manage Roles**, **Send Messages**, **Embed Links**,
   **Read Message History**. Invite it to the MET server.
6. In **Server Settings → Roles**, drag the bot's role **above every punishment
   role**. Discord will not let it assign a role positioned above its own.

### 2. Database
```bash
cp .env.example .env      # then fill it in
npm install
npx prisma migrate deploy # or: npx prisma migrate dev  (first run)
```

### 3. The quota sheet
Two write paths; the Apps Script one is primary and much more reliable.

**Apps Script (recommended).** Open the sheet → Extensions → Apps Script, paste
`scripts/quota-webhook.gs`, set `SECRET`, then Deploy → New deployment → Web
app (*Execute as: Me*, *Who has access: Anyone*). Put the `/exec` URL in
`QUOTA_WEBHOOK_URL` and the same secret in `QUOTA_WEBHOOK_SECRET`.

**Service account (fallback).** Create one in Google Cloud, enable the Sheets
API, and paste the whole key JSON on one line into
`GOOGLE_SERVICE_ACCOUNT_JSON`. **Share the sheet with the key's `client_email`
as an Editor** — without that every call 403s.

The sheet needs a header row containing a username and/or Discord ID column plus
weekday columns. Headers are found by text, not position, so they can live on
any row.

### 4. Roblox
- `ROBLOX_GROUP_ID` — the MET group id.
- `ROVER_API_KEY` — for Discord↔Roblox links. Without it the bot falls back to
  the public, heavily rate-limited API.
- `ROBLOX_COOKIE` — the `.ROBLOSECURITY` of the account that performs group
  actions. That account needs **Remove Members** (exile) and **Manage
  lower-ranked member ranks** (promote/demote), and its group rank must sit
  **above** everyone it acts on.

Leave the cookie unset and the bot still runs — exile and rank changes are
skipped with a logged warning instead of failing.

### 5. Register the commands and start
```bash
npm run deploy    # registers the 7 commands in DISCORD_GUILD_ID (instant)
npm start
```
Re-run `npm run deploy` after changing any command's name, description or
options.

## Operational notes

- **Nothing is lost on a restart.** Review-card buttons carry their record id,
  and point awards live in the `quota_awards` table until the sheet write
  actually succeeds (30s worker, up to 40 attempts, then `FAILED` with a log
  line telling you to add them manually).
- **RoVer rate limits** trip a cooldown: while it holds the bot serves cached
  and stored links rather than calling out, because retrying extends the ban.
  Discord↔Roblox links are cached in `roblox_links` and consulted before RoVer.
- **Points always go to the filer**, never the subject of the case.
- **Nobody can review their own submission**, and a Supervisor cannot approve a
  case carrying `Blacklist` or `Termination`.
