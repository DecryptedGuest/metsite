# 🛡 MET Police Service Portal

A secure, Discord-authenticated portal for the MET Police roleplay community, covering
five divisions from one codebase and one login:

| Division | Abbr. | Scope |
|----------|-------|-------|
| Criminal Investigation Department | **CID**   | Open cases, log evidence/notes, assign investigators, track status |
| Specialist Firearms Command       | **SCO-19**| Log firearms deployments/authorisations, lead sign-off |
| Internal Affairs                  | **IA**    | Case management, ticketing, quotas, audit log (the original system) |
| Frontline Policing                | **FLP**   | Shift start/end, incidents attended, arrests made |
| Hendon Police College             | **HPC**   | Cadet roster, course tracking, pass/fail, graduation sign-off |

IA is the original, fully-featured system this portal grew from — its case management,
ticketing, quota tracking, audit log, Discord role-gating and webhook posting are
unchanged, just re-homed under `/ia`. The other four divisions are lighter-weight tools
scoped to what each division actually needs.

---

## Tech Stack

| Layer      | Technology                          |
|------------|--------------------------------------|
| Backend    | Node.js + Express                   |
| Database   | PostgreSQL + Prisma ORM             |
| Auth       | Discord OAuth2 + JWT (httpOnly cookie), shared across all divisions |
| Frontend   | Vanilla HTML/CSS/JS (glassmorphism) |
| Hosting    | Railway                             |

---

## Project Structure

```
metsite/
├── server/
│   ├── index.js              # Express entry point — hub route, /ia/* + /cid|sco19|flp|hpc/* mounts
│   ├── routes/
│   │   ├── auth.js           # Shared Discord OAuth flow (all divisions)
│   │   ├── cases.js          # IA case CRUD + audit (unchanged)
│   │   ├── tickets.js        # IA ticketing (unchanged)
│   │   ├── admin.js          # IA admin panel (unchanged)
│   │   ├── cid.js            # CID case log
│   │   ├── sco19.js          # SCO-19 deployment log
│   │   ├── flp.js            # FLP shift log
│   │   └── hpc.js            # HPC training records
│   ├── middleware/
│   │   ├── auth.js           # JWT verification + IA role guards (unchanged)
│   │   └── division.js       # requireDivision()/requireDivisionLead() — per-division gate
│   └── lib/
│       ├── db.js             # Prisma client singleton
│       ├── roleResolver.js   # Site role (IA) + division access resolution
│       ├── accessControl.js  # Background revalidator — refreshes role AND divisions
│       ├── refGen.js         # Reference generator for the new division models
│       └── webhook.js        # Discord webhook sender (IA)
├── client/
│   ├── views/
│   │   ├── index.html            # Hub — the 5 division cards + your rank in each
│   │   ├── profile.html          # Officer profile — roles/perms/punishments/ranks
│   │   ├── portal-denied.html    # Generic "no access" page (used by all new divisions)
│   │   ├── login.html            # IA's own login page (/ia/login)
│   │   ├── dashboard.html        # IA's dashboard (/ia/dashboard) — unchanged, + shared topbar
│   │   ├── denied.html           # IA's own denied page (/ia/denied)
│   │   ├── cid-dashboard.html
│   │   ├── sco19-dashboard.html
│   │   ├── flp-dashboard.html
│   │   └── hpc-dashboard.html
│   └── public/
│       ├── css/
│       │   ├── main.css          # Global styles (shared design tokens)
│       │   ├── dashboard.css     # Dashboard component styles (shared)
│       │   └── met-portal.css    # Hub + shared topbar styles (new)
│       └── js/
│           ├── ui.js             # Toast, modal, API helpers (shared, unchanged)
│           ├── dashboard.js      # IA dashboard logic (unchanged)
│           ├── met-topbar.js     # Shared topbar: user info + "Switch division" (new)
│           ├── profile.js        # Officer profile page logic (new)
│           ├── cid-dashboard.js
│           ├── sco19-dashboard.js
│           ├── flp-dashboard.js
│           └── hpc-dashboard.js
├── prisma/
│   └── schema.prisma         # Database schema — IA's models untouched, new division models added
├── railway.toml              # Railway deploy config
└── .env.example              # Environment variable template
```

---

## How access works

Login is one shared Discord OAuth2 flow for the whole portal (`/auth/discord`). After
signing in, a user lands on the hub (`/`), which shows all 5 divisions with the user's
**rank in each** — cards for divisions they belong to link to that division's dashboard;
the rest are shown locked.

**Division membership + rank come from Roblox groups, not Discord roles.** Each of the
four new divisions is a Roblox group held by the **holder account**
(`FNTHOLDER_V2` by default, via `DIVISION_HOLDER_USERNAME`), whose group icon becomes the
division's icon. A user's rank in that group — resolved through RoVer, exactly the way IA
already resolves its rank — decides whether they're in the division and at what tier
(`MEMBER` or `LEAD`). There is **no Discord-role fallback**: if the group rank can't be
read, the user has no access to that division. The resolved divisions are cached on
`User.divisions` and refreshed at login and by the same background job that refreshes IA's
`role`. `server/lib/divisions.js` is the single place group ids, icons, and rank→tier
mapping live.

**IA is the exception** and is deliberately left on its original pipeline: IA access is
governed by the IA **site role** (`IA` / `SUPERVISOR` / `HICOMM` / `DEVELOPER`) derived
from the IA Roblox group by `roleResolver.js` — unchanged from the original system, and
independent of the `divisions` cache so IA can never be locked out by a stale cache. That
site role still governs everything *inside* IA (who can approve a case, view the audit
log, etc.) exactly as before.

A `DEVELOPER` always has LEAD access to every division. Visiting a division you don't
belong to redirects to that division's `/denied` page.

The **LEAD (high-rank) tier** — which unlocks a division's restricted actions — is defined
per the divisional spec:

| Division | LEAD when the member's Roblox rank is… |
|----------|----------------------------------------|
| CID, SCO-19 | Assistant Commander / Director and above |
| FLP, HPC    | Deputy Director and above |
| IA          | HICOMM / SUPERVISOR site role (i.e. Deputy Director+ in the IA group) |

> **Tiers are provisional.** LEAD is currently matched by rank **name** (see
> `LEAD_RANK_PATTERNS` in `server/lib/divisions.js`), so "and above" ranks with other
> names won't be recognised until each group's full rank ladder is confirmed. Override
> per division with `LEAD_MIN_RANK_<DIV>` (member is LEAD when their group rank number is
> ≥ that value) once the exact ranks are known.

---

## Local Setup

### 1. Clone & Install

```bash
git clone <this-repo>
cd metsite
npm install
```

### 2. Create Discord Application

1. Go to https://discord.com/developers/applications
2. Click **New Application** → name it "MET Police Portal"
3. Go to **OAuth2** → copy **Client ID** and **Client Secret**
4. Under **Redirects**, add:
   - `http://localhost:3000/auth/discord/callback` (local)
   - `https://your-app.railway.app/auth/discord/callback` (production)
5. Go to **Bot** → Create a Bot → copy **Bot Token**
6. Invite the bot to your server with `Server Members Intent` enabled (under **Privileged Gateway Intents**)

### 3. Create Discord Webhook (IA)

1. In your Discord server, go to the channel where approved IA cases should be posted
2. **Edit Channel** → **Integrations** → **Webhooks** → **New Webhook**
3. Copy the webhook URL into `DISCORD_WEBHOOK_URL`

### 4. Configure Environment

```bash
cp .env.example .env
```

Fill in the Discord app credentials, `JWT_SECRET`, `DATABASE_URL`, and — for each
division you want to gate — its role IDs (see **Role Mapping** below). Leaving a
division's role env vars unset just means nobody but a `DEVELOPER` can reach it yet.

**To generate a JWT secret:**
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

**To find a Discord role/server ID:**
Enable Developer Mode in Discord (Settings → Advanced → Developer Mode), then
right-click a role/server and **Copy ID**.

### 5. Set Up Database

```bash
npx prisma migrate deploy   # applies every migration in prisma/migrations, in order
npx prisma generate
```

(`npx prisma db push` also works for quick local iteration, but the deploy flow uses
`migrate deploy` — see `railway.toml`.)

### 6. Run Locally

```bash
npm run dev
```

Visit `http://localhost:3000` — you'll land on the hub.

---

## Deploying to Railway

### Step 1: Push to GitHub

```bash
git push -u origin main
```

### Step 2: Create Railway Project

1. Go to https://railway.app → **New Project**
2. Select **Deploy from GitHub repo**
3. Choose this repository

### Step 3: Add PostgreSQL

In your Railway project, click **+ New** → **Database** → **Add PostgreSQL**.
Railway automatically sets `DATABASE_URL`.

### Step 4: Set Environment Variables

Copy every variable from `.env.example` into your Railway service's **Variables** tab,
filled in with real values (Discord credentials, `JWT_SECRET`, the `ROLE_*` IDs for each
division you're enabling, etc). `DATABASE_URL` is already set by the PostgreSQL plugin.

### Step 5: Update Discord OAuth Redirect

In the Discord Developer Portal → **OAuth2** → **Redirects**, add your Railway URL:
```
https://your-app.railway.app/auth/discord/callback
```

### Step 6: Deploy

Railway auto-deploys on every push to `main`. `railway.toml` handles:
- Running `npm install` + `prisma generate`
- Starting the server with `prisma db push --accept-data-loss && node server/index.js`

Railway runs the app as a single always-on process, so the Discord bot and background
workers run here. **This is the recommended host for the full app.**

---

## Deploying to Vercel

Vercel is **serverless** — it runs the app as per-request functions with no always-on
process. The repo is set up for it (`vercel.json` + `api/index.js` export the Express app;
`server/index.js` skips its background workers and doesn't bind a port when imported), so
the web app deploys and serves fine. Just be aware of what serverless can't do:

**Works on Vercel:** the hub, officer profile, all dashboards, Discord OAuth login,
division access/rank resolution, and every HTTP API — these use HTTP calls (RoVer, Roblox
groups, Discord OAuth), not a persistent connection.

**Does _not_ work on Vercel** (needs an always-on process — run it on Railway/Fly/a small
worker, or trigger via a scheduler):
- **Discord bot gateway** — role assignment, group management, ticket-transcript matching.
- **Background workers** — access revalidation + the quota outbox retry loop. (Login still
  resolves roles live via RoVer, so day-to-day auth is unaffected; only the periodic
  reconciliation stops.)
- **Media uploads larger than ~4.5 MB** — Vercel's hard serverless request-body limit.

### Steps

1. **Import the repo** at vercel.com → New Project. No framework preset needed; `vercel.json`
   already routes every request to `api/index.js` and bundles the `client/` views/assets.
2. **Set the environment variables** — the same ones from `.env.example` (Discord creds,
   `JWT_SECRET`, the `GROUP_*` ids, etc.). Vercel sets `VERCEL=1` itself, which is what
   disables the background workers.
3. **Use a pooled `DATABASE_URL`.** Serverless opens many short-lived connections, so point
   at a pooler (Supabase pooler, Neon, PgBouncer, or Prisma Accelerate) — not a direct
   Postgres connection, which will exhaust connections.
4. **Run migrations yourself** (Vercel has no start command): from a machine with access to
   the production database,
   ```bash
   DATABASE_URL="<prod-url>" npx prisma migrate deploy
   ```
   Do this on each schema change; don't run migrations during the Vercel build.
5. **Deploy.** `prisma generate` runs in the build (the schema declares the `rhel-openssl-*`
   engines Lambda needs). The 404 you saw before was just the missing `vercel.json`/entrypoint.

> **Recommended:** run the web app on Vercel and a tiny always-on companion (Railway/Fly)
> that runs `DISABLE_WORKERS` unset (i.e. `node server/index.js`) purely to host the Discord
> bot + workers against the same database. Or keep the whole thing on Railway.

---

## MET bot data contract

The officer profile page (`/profile`) shows each officer's MET-server roles, perms and
punishment history as Discord-style chips. That data is **written by the MET bot** into
two tables in this same database — the site only reads them, and the profile degrades
gracefully (division ranks still show; a notice explains the rest is pending) until the
bot populates them.

**`met_member_profiles`** — one row per member, upserted on `discordId`:

| Column | Meaning |
|--------|---------|
| `discordId` (unique) | the member's Discord id |
| `discordUsername`, `metNickname` | display fields |
| `robloxId`, `robloxUsername` | linked Roblox identity (optional) |
| `roles` (JSON) | MET-server Discord roles → chips: `[{ id, name, color, position, icon }]` (`color` = Discord's decimal int or `#hex`) |
| `perms` (JSON) | multi-division / gang / portal perms → chips: `[{ key, label, category, color }]` |

**`met_punishments`** — one row per punishment, inserted by the bot:

| Column | Meaning |
|--------|---------|
| `discordId` | the punished member |
| `type` | `WARNING` / `STRIKE` / `SUSPENSION` / `BAN` / `DEMOTION` / … (free-form) |
| `reason`, `issuedBy`, `issuedById`, `caseRef` | details |
| `active`, `issuedAt`, `expiresAt` | status + timing |

The bot connects with the same `DATABASE_URL` and writes these rows; nothing else on the
site needs to change for the profile to light up. Division rank/quota and division access
continue to come from Roblox groups (above), independent of this bot data.

**Perms and standing flags the site derives itself (no bot needed).** In addition to any
bot-written `perms`, the profile now derives:

* **Permissions** from the member's rank in the **perms group** (`PERMS_GROUP_ID`, default
  `381582724`) — every rank `2..99` becomes a perm chip (QUOTA EXEMPT, GANG PERMS, MULTI
  DIVISION PERMS, the BUYER perms, the RANK-LOCK perms, …), coloured by the group's colour
  scheme. Guest/Member and rank `100+` (MET ADMINISTRATION / HICOMM / Overseer / HOLDER)
  are the member's MET *rank*, not a perm, so they're filtered out, as are the divider
  roles (`-----`). Site-derived and bot-written perms are merged and de-duplicated. The
  catalogue and filtering live in `server/lib/permsGroup.js`. **Multiple roles per group:**
  Roblox now lets a member hold more than one role in a single group; the site collects
  **every** perm role the account holds (via `getUserGroupRoles`), so all their perms show —
  not just one.
* **Standing flags** from the disciplinary Discord roles (`ROLE_ACTIVITY_STRIKE`,
  `ROLE_STRIKE_1/2/3`, `ROLE_SUSPENDED`, `ROLE_VERBAL_WARNING`, `ROLE_ZT`) — captured from
  the member's Discord roles at login (`users.metRoleIds`) and shown as coloured chips.

**Punishment history** on the profile now includes the member's own **Internal Affairs
cases** (`cases` + `case_punishments`, matched by their Roblox id / username / suspect
Discord id) with reason, issuer, expiry and active/expired status — merged with any
bot-written `met_punishments` and shown newest-first. See `server/lib/punishments.js`.
*Note:* that history lives in the Postgres DB, not in the repo. If this site already points
at the same `DATABASE_URL` as the old IA site, the cases are already there and now show.
Otherwise, either point `DATABASE_URL` at the IA database, or `pg_dump` the IA DB's
`cases` / `case_actions` / `case_punishments` (and `case_counter`) tables and restore them
into this database.

**Divisions render as coloured role chips** following the MET Discord colour scheme (FLP
blue, SCO-19 grey, CID orange, HPC white, IA teal; MI5 sky-blue reserved) — see
`META[...].color` in `server/lib/divisions.js`.

### Developer division

The developer tools (Dev Panel, Group Panel, Discord Moderation, Visits, Security, Site
Control, Send Notification, Media Admin) are their own **Developer division** at
`/dev/dashboard` — no longer mixed into the Internal Affairs section. The IA dashboard view
is reused: served from `/dev` it switches to "developer mode" (dev nav only, IA nav hidden);
served from `/ia/dashboard` the dev nav is never shown, even to developers. Access is
developers-only (`role === 'DEVELOPER'`), and the division appears in developers' profile +
division switcher.

### Tryout server lock (live from the game)

Tryout announcements show the live **server-lock** state (Adonis `:serverlock on/off` /
`:slock`) of the Hendon Police Campus game — not a static "shift-lock". When the lock
toggles in-game, the game POSTs `/api/game/serverlock` (authenticated with the
`x-game-secret` header = `TRYOUT_GAME_SECRET`), and the site updates the tryout and edits
its Discord announcement in real time. In-game HTTP example (Adonis command hook /
HttpService):

```lua
game:GetService("HttpService"):PostAsync(
  "https://<your-site>/api/game/serverlock",
  game:GetService("HttpService"):JSONEncode({ locked = true }),  -- or false
  Enum.HttpContentType.ApplicationJson, false,
  { ["x-game-secret"] = "<TRYOUT_GAME_SECRET>" }
)
```

Body accepts `{ locked: true|false }` (or `state: "on"/"off"`), and optionally `tryoutId`
or `privateServerId` to target a specific tryout (otherwise the current live one is used).

## Division → Roblox group mapping

The four new divisions resolve membership + rank from a Roblox group held by
`DIVISION_HOLDER_USERNAME` (`FNTHOLDER_V2`). Pin each group id explicitly (recommended),
or leave it blank to auto-discover it by matching the holder account's groups by name.

| Division | Group id env var | Lead threshold env var | Notes |
|----------|------------------|------------------------|-------|
| CID      | `GROUP_CID`      | `LEAD_MIN_RANK_CID`    | Lead can reassign a case's investigators |
| SCO-19   | `GROUP_SCO19`    | `LEAD_MIN_RANK_SCO19`  | Lead can sign off / reject a deployment |
| FLP      | `GROUP_FLP`      | `LEAD_MIN_RANK_FLP`    | No lead-only actions yet — all officers log their own shifts |
| HPC      | `GROUP_HPC`      | `LEAD_MIN_RANK_HPC`    | Lead acts as the instructor: enrols cadets, sets pass/fail |

`LEAD_MIN_RANK_<DIV>` is the Roblox group rank number at/above which a member is treated
as `LEAD` (default 255 = owner only). This is provisional until each division's real rank
ladder is defined — see the note under **How access works**.

IA is **not** in this table: IA access comes from the IA site role, mapped from the IA
Roblox group (`IA_GROUP_ID`, default `407296071`) by `roleResolver.js`, using `ROLE_IA` /
`ROLE_HICOMM` / `ROLE_SUPERVISOR` as the Discord-role fallback — all unchanged from the
original IA system.

`DEVELOPER_DISCORD_ID` (and `DEVELOPER_ROLE_ID`/`DEVELOPER_ROLE_ID2`) always grant LEAD
access to every division.

---

## API Endpoints

### Auth (shared)
| Method | Path                    | Description                  |
|--------|-------------------------|------------------------------|
| GET    | `/auth/discord`         | Redirect to Discord OAuth    |
| GET    | `/auth/discord/callback`| OAuth callback handler       |
| POST   | `/auth/logout`          | Clear session, redirect to hub |
| GET    | `/api/me`               | Current user info (incl. `divisions`) |
| GET    | `/api/me/divisions`     | Divisions the current user can access, for the hub + "Switch division" |

### IA (`/api/cases`, `/api/tickets`, `/api/admin`, ... — unchanged, now gated to IA division)
See the code in `server/routes/` — behaviour is identical to the original IA system.

### CID (`/api/cid`)
| Method | Path                              | Access     | Description |
|--------|-----------------------------------|------------|--------------|
| GET    | `/api/cid/cases`                  | CID member | List cases |
| GET    | `/api/cid/cases/:id`               | CID member | Case detail + evidence/notes |
| POST   | `/api/cid/cases`                   | CID member | Open a case |
| POST   | `/api/cid/cases/:id/entries`       | CID member | Log a note/evidence entry |
| PATCH  | `/api/cid/cases/:id/status`        | CID member | Open / Under Review / Closed |
| PATCH  | `/api/cid/cases/:id/assign`        | CID lead   | Reassign lead/assigned investigators |

### SCO-19 (`/api/sco19`)
| Method | Path                                     | Access       | Description |
|--------|------------------------------------------|--------------|--------------|
| GET    | `/api/sco19/deployments`                  | SCO-19 member| List deployments |
| POST   | `/api/sco19/deployments`                  | SCO-19 member| Log a deployment |
| PATCH  | `/api/sco19/deployments/:id/sign-off`     | SCO-19 lead  | Sign off / reject |

### FLP (`/api/flp`)
| Method | Path                        | Access     | Description |
|--------|-----------------------------|------------|--------------|
| GET    | `/api/flp/shifts`           | FLP member | Recent shifts, all officers |
| GET    | `/api/flp/shifts/my`        | FLP member | Your own shift history |
| GET    | `/api/flp/stats`            | FLP member | Aggregate stats for the dashboard |
| POST   | `/api/flp/shifts`           | FLP member | Start a shift |
| PATCH  | `/api/flp/shifts/:id/end`   | FLP member | End your shift (incidents/arrests/notes) |

### HPC (`/api/hpc`)
| Method | Path                          | Access        | Description |
|--------|-------------------------------|---------------|--------------|
| GET    | `/api/hpc/records`             | HPC member    | Full training roster |
| GET    | `/api/hpc/records/my`           | HPC member    | Your own course history |
| POST   | `/api/hpc/records`               | HPC lead (instructor) | Enrol a cadet (by Discord ID) onto a course |
| PATCH  | `/api/hpc/records/:id/status`   | HPC lead (instructor) | Set pass/fail/graduated + note |

---

## Security Features

- JWT stored in **httpOnly, Secure, SameSite=Lax** cookie (not accessible to JS), shared across every division
- Site role AND division access **re-fetched from the database on every request** (role/role changes take effect immediately)
- Rate limiting on `/auth` (50 req/15min) and `/api` (120 req/min)
- All inputs sanitised before database write
- Webhook URLs stored in environment variables only
- `bcrypt`-free (OAuth-only, no password storage)

---

## Troubleshooting

**"You must be a member of the MET Discord server"**
→ The user's OAuth token couldn't fetch their guild membership. Ensure the bot is in your server and has Member Intent enabled.

**Redirected to a division's `/denied` page**
→ Double-check that division's `ROLE_*` / `ROLE_*_LEAD` values match the user's actual Discord role IDs (right-click role → Copy Role ID with Developer Mode on).

**Database errors on Railway**
→ Ensure `DATABASE_URL` is set (auto-provided by Railway's PG plugin). Run `prisma migrate deploy` via Railway's shell if the schema looks out of date.

**Discord OAuth redirect mismatch**
→ The `DISCORD_REDIRECT_URI` in `.env` must exactly match one of the registered redirects in the Discord Developer Portal.
