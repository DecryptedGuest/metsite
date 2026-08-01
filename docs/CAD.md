# CAD — Metropolitan Police Computer-Aided Dispatch

A text-driven UK police dispatch system built into the MET portal, with AI
text-to-speech read out into a Discord voice channel. Two interfaces sit on one
pure dispatch state machine:

- **Dispatchers** run the **web console** — dev panel → **CAD Dispatch**.
- **Officers** talk in a Discord **#radio** text channel in plain English
  (e.g. `MP-1 to control, show me en route`); an intent parser turns that into
  the same actions the console uses.

Every dispatch response is phrased like real UK radio, **mirrored to #radio as
text**, and (when configured) **spoken** into a voice channel by ElevenLabs TTS.
Grade I (Immediate) jobs are prefixed with an attention tone.

Phase 2 (voice **input** / speech-to-text) is architected for but not built:
the parser and services take plain text and typed results, so STT can be dropped
in front of the same `parseIntent()` → service pipeline.

## Architecture

The dispatch logic lives in a **services layer with zero discord.js imports**,
so it is unit-tested with a mocked Prisma and can later be driven by STT.

```
server/lib/cad/
  result.js            typed { ok, ... } | { ok:false, error, code } helpers
  units.service.js     book on/off, status, live board          (pure)
  dispatch.service.js  incidents, assign, on-scene, close, backup (pure)
  pnc.service.js       PNC vehicle/person lookups               (pure)
  phrasing.js          UK-radio response strings                (pure)
  services.js          binds the pure services to the real Prisma
  intent/parser.js     IntentParser: Claude (fetch) + rule-based fallback
  tts/types.js         TtsProvider interface + NullTtsProvider
  tts/elevenlabs.js    ElevenLabs TtsProvider (en-GB)
  voice/dispatch-voice.js  join VC, one AudioPlayer, single-transmission queue
  index.js             orchestrator: transmit(), #radio handler, actions, init()
  seed.js              ~20 fictional London vehicles + persons
server/routes/cad.js   developer-only REST for the web console
client/public/js/cad-console.js + dev-dashboard "CAD Dispatch" tab
test/cad/*             node:test unit tests (mocked Prisma)
```

## Data model (Prisma, prefixed `Cad`)

`CadUnit`, `CadIncident`, `CadIncidentLog`, `CadVehicleRecord`, `CadPersonRecord`
plus enums `CadUnitStatus` (OFF_DUTY, AVAILABLE, EN_ROUTE, ON_SCENE, BUSY,
MEAL_BREAK, URGENT_ASSISTANCE), `CadGrade` (I/S/E/R) and `CadIncidentStatus`
(OPEN/ASSIGNED/ON_SCENE/CLOSED). `cadRef` is `INC-YYYYMMDD-NNN` per day. Units
link to the officer's MET site account; `officerName` defaults to their MET
display name when they book on.

## Setup

1. **Migrate** — the new models ship in `prisma/schema.prisma`. On deploy the
   `start` script runs `prisma db push`; locally: `npm run db:push`.
2. **Seed PNC** — dev panel → CAD Dispatch → **Seed PNC** (or the services'
   `seedPnc()`). Idempotent.
3. **(Optional) Radio channel** — set `CAD_RADIO_CHANNEL_ID` to a text channel.
   This also switches on the Discord **Message Content** intent, so make sure
   the bot has it enabled in the Developer Portal.
4. **(Optional) Voice/TTS** — install the audio deps and set the keys:
   ```
   npm i @discordjs/voice opusscript libsodium-wrappers ffmpeg-static
   ```
   then set `CAD_VOICE_CHANNEL_ID`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`.
   Without these the CAD runs **text-only** (mirrors to #radio, no speech).
5. **(Optional) Claude intent parsing** — set `ANTHROPIC_API_KEY`. Without it a
   deterministic **rule-based** parser handles the radio channel.

No slash commands are registered — the console replaces them; the radio channel
is the officer-facing interface.

## Environment

See `.env.example` (the `CAD —` block): `CAD_GUILD_ID`, `CAD_RADIO_CHANNEL_ID`,
`CAD_VOICE_CHANNEL_ID`, `CAD_CONTROL_ROLE_ID`, `CAD_ATTENTION_TONE_PATH`,
`ANTHROPIC_API_KEY`, `CAD_INTENT_MODEL`, `CAD_INTENT_MIN_CONFIDENCE`,
`ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID`.

## Radio → intent

`parseIntent(text)` returns `{ callsign, intent, entities, confidence }`,
validated in-house. Intents: `BOOK_ON, BOOK_OFF, STATUS_UPDATE, VRM_CHECK,
PERSON_CHECK, ASSIGN_REQUEST, ON_SCENE, INCIDENT_UPDATE, REQUEST_BACKUP,
UNKNOWN`. Below `CAD_INTENT_MIN_CONFIDENCE` (0.6) or `UNKNOWN`, control replies
in text asking the officer to say again and **does not speak** it.

## Tests

```
npm test            # node:test, dispatch.service + units.service, mocked Prisma
```

## Swapping providers

- **TTS**: implement `TtsProvider` (`synthesize(text) -> { ok, audio, mime }`)
  and pass it to `DispatchVoice` — ElevenLabs is one implementation.
- **Intent**: `parser.js` isolates the model call; swap `claudeParse` or point
  `CAD_INTENT_MODEL` elsewhere. The rule-based fallback stays as a safety net.
