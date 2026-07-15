# MET CAD — Voice Worker

A tiny standalone Discord bot whose **only** job is to sit in a voice channel and
speak the CAD's transmissions out loud with ElevenLabs TTS.

## Why this exists

Discord voice requires an **outbound UDP** handshake. Railway (where the main
portal runs) does not route outbound UDP, so the voice connection reaches
`connecting`, stalls in `signalling`, and never becomes `Ready` — it joins but
never speaks. This worker runs on **Fly.io**, which *does* allow outbound UDP, so
the handshake completes and audio plays.

The main Railway app keeps doing everything text (the `#radio` mirror, the
dispatch console, incidents, PNC). It just forwards each spoken line here over
HTTPS. If the worker is down, the CAD carries on text-only.

```
 Dispatch console ──▶ Railway app ──(HTTPS /speak)──▶ Voice Worker (Fly.io) ──▶ 🔊 Discord VC
```

## Two ways to link it to the main app

- **Gateway (dial-out) mode — recommended, works on FREE hosts.** The worker
  connects *out* to the main app over a secure WebSocket, so it needs no public
  inbound URL. Set `CAD_MAIN_WS_URL` on the worker and only
  `CAD_VOICE_WORKER_SECRET` on the main app. This is the mode to use on free
  Discord-bot hosts like **bot-hosting.net** (no credit card, 24/7, Discord
  login) — see "Deploy free (no card)" below.
- **HTTP mode.** The main app calls the worker directly; needs a host that gives
  the worker a public URL (e.g. Fly.io). Set `CAD_VOICE_WORKER_URL` +
  `CAD_VOICE_WORKER_SECRET` on the main app — see "Deploy to Fly.io" below.

## What you need

1. **A second Discord bot.** Two processes can't share one gateway login, so
   create a *second* Discord application at <https://discord.com/developers/applications>,
   add a Bot, copy its token → `VOICE_BOT_TOKEN`. Invite it to your server with
   **Connect** and **Speak** (and enable the *Server Members* / *Voice States*
   intents aren't needed — only Guilds + Voice States, which are non-privileged).
   Invite URL (replace CLIENT_ID):
   `https://discord.com/oauth2/authorize?client_id=CLIENT_ID&scope=bot&permissions=3145728`
   (`3145728` = Connect + Speak.)
2. **A shared secret** — any long random string. Put the SAME value here as
   `WORKER_SECRET` and on Railway as `CAD_VOICE_WORKER_SECRET`.
3. **Your ElevenLabs API key** → `ELEVENLABS_API_KEY`.

## Deploy free & always-on — Oracle Cloud (no reclaim, no commands)

Oracle Cloud's Always Free VM runs 24/7 and is never billed (a card is taken at
signup for identity only). Nothing reclaims it like free bot panels do. Setup is
browser-only: you paste `oracle-cloud-init.sh` into the VM's cloud-init box and
it installs + runs the worker itself.

1. On the **main app** (Railway) add `CAD_VOICE_WORKER_SECRET` = a long random
   string, and redeploy. Note your Railway domain (Settings → Domains).
2. Open **`voice-worker/oracle-cloud-init.sh`**, fill in the four values at the
   top (`VOICE_BOT_TOKEN`, `WORKER_SECRET` = the same secret as step 1,
   `ELEVENLABS_API_KEY`, `CAD_MAIN_WS_URL` = `wss://<your-railway-domain>/cad-voice`).
3. Sign up at **cloud.oracle.com** → **Create Instance**:
   - Image: **Ubuntu 22.04**; Shape: **VM.Standard.E2.1.Micro** (Always Free).
   - SSH keys: pick "Generate a key pair for me" and download it (you won't need it).
   - **Show advanced options → Management → Cloud-init script** → paste your
     filled-in `oracle-cloud-init.sh` → **Create**.
4. Wait ~3 minutes. On the site, **Dev → CAD** shows **"Voice host: worker
   (linked)"**. Pick server + channel → Join → Radio check. 🎙️

It auto-restarts on crash and survives reboots (systemd service `met-voice`).

## Deploy free (no card) — bot-hosting.net, all from a phone

A free Discord-bot host runs the worker 24/7 with no credit card. Because it has
no public inbound URL, use **gateway mode** (the worker dials out).

1. On the **main app** (Railway), add ONE variable and redeploy:
   - `CAD_VOICE_WORKER_SECRET` = any long random string (write it down).
2. Go to **bot-hosting.net** → sign in with Discord (free, no card) → **Create a
   server** (Node.js).
3. In the panel → **Settings / Startup**, set it to pull this repo:
   - Git repo: `https://github.com/DecryptedGuest/metsite`
   - Branch: `claude/group-roles-permissions-6yn2fq`
   - Startup command: `cd voice-worker && npm install && node index.js`
4. In the panel → **Startup / Variables**, add these environment variables:
   - `VOICE_BOT_TOKEN` = your second bot's token
   - `WORKER_SECRET` = the SAME string you set on Railway in step 1
   - `ELEVENLABS_API_KEY` = your ElevenLabs key
   - `CAD_MAIN_WS_URL` = `wss://YOUR-RAILWAY-DOMAIN/cad-voice`
     (your Railway public domain, e.g. `wss://metsite-production.up.railway.app/cad-voice`)
5. **Start** the server. In its console you should see `logged in as …` then
   `gateway: connected`.
6. On the site: **Dev → CAD** shows **"Voice host: worker (linked)"**. Pick the
   server + voice channel → **Join** → **Radio check**. It speaks. 🎙️

No terminal, no card, and it stays on 24/7.

## Deploy from your phone (Fly.io, no commands)

A GitHub Action (`.github/workflows/deploy-voice-worker.yml`) builds and deploys
this worker to Fly.io on GitHub's servers — you never open a terminal.

1. Make a Fly.io account at <https://fly.io> and add a payment method (the worker
   is tiny, roughly a couple of £/$ a month running 24/7).
2. In the Fly dashboard, create an **access token** (avatar menu → *Access Tokens*
   → create → copy it).
3. In your GitHub repo → **Settings → Secrets and variables → Actions → New
   repository secret**, add these four:
   - `FLY_API_TOKEN` — the Fly token from step 2
   - `VOICE_BOT_TOKEN` — the second bot's token
   - `WORKER_SECRET` — any long random string (use the SAME value on Railway as
     `CAD_VOICE_WORKER_SECRET`)
   - `ELEVENLABS_API_KEY` — your ElevenLabs key
4. Go to the repo's **Actions** tab → **Deploy CAD Voice Worker** → **Run
   workflow**. When it finishes green, the log prints the worker URL
   (`https://metsite-cad-voice.fly.dev`).
5. Add that URL to Railway as `CAD_VOICE_WORKER_URL` and the same secret as
   `CAD_VOICE_WORKER_SECRET` (see *Point Railway at it* below).

The CLI route below is the alternative if you prefer a computer.

## Deploy to Fly.io (CLI alternative)

Install the Fly CLI (`flyctl`) and log in (`fly auth login`), then from this
`voice-worker/` folder:

```bash
# 1. Create the app (accept the existing fly.toml; DON'T deploy yet).
fly launch --no-deploy

# 2. Set secrets (these never touch git).
fly secrets set \
  VOICE_BOT_TOKEN="your-second-bot-token" \
  WORKER_SECRET="a-long-random-string" \
  ELEVENLABS_API_KEY="your-elevenlabs-key"

# 3. Deploy.
fly deploy
```

Grab the public URL Fly prints (e.g. `https://metsite-voice-worker.fly.dev`).

## Point Railway at it

Add these two env vars to the **Railway** service and redeploy:

```
CAD_VOICE_WORKER_URL=https://metsite-voice-worker.fly.dev
CAD_VOICE_WORKER_SECRET=<the same WORKER_SECRET>
```

That's it. In the dev CAD console pick the server + voice channel as before — the
main app now tells the worker to join, and every transmission is spoken from
Fly.io. The console's voice panel shows the worker's live status and event log.

## HTTP API (called by the Railway app)

All but `/health` require the `X-Worker-Secret` header.

| Method | Path      | Body                                   | Purpose                     |
|--------|-----------|----------------------------------------|-----------------------------|
| GET    | `/health` | –                                      | status + event ring buffer  |
| POST   | `/join`   | `{ guildId, channelId }`               | join / move to a channel    |
| POST   | `/leave`  | –                                      | leave the channel           |
| POST   | `/speak`  | `{ guildId?, channelId?, text, grade? }` | queue a line to speak     |

## Run locally (optional)

```bash
cp .env.example .env   # fill it in
npm install
npm start              # listens on :8080
```

Local dev works too — anywhere with outbound UDP (your own PC, a VPS) is fine;
Fly.io is just the easy always-on option.
