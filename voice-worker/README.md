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

## Deploy from your phone (no commands)

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
