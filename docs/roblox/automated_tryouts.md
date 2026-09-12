# Automated tryout contracts

Everything below is live on the portal. Base URL is the value already in
`HPCTryoutConfig.SITE_URL`. Every request carries `x-game-secret`.

## 1. NPC host

Option A, as you preferred. No service account, nothing for you to create.

Send on `POST /api/game/tryout/create`:

```json
{ "host": { "type": "npc", "name": "INSTRUCTOR" }, "division": "HPC" }
```

`host.type` is the only field that matters. When it is `npc` the portal skips
host resolution entirely, stores the tryout with no owning site user, marks the
row `automated` and `hostKind = "npc"`, and skips the host DM. `host.name` is
optional and defaults to `INSTRUCTOR`.

One correction to your section 2. `POST /api/game/tryout/conclude` was never
going to 422 for this. `createFromGamePayload` already treats an unresolvable
host as a host with no linked account and files the log as `PENDING` instead of
failing. The 422 branch in your Lua is real but fires for other reasons. The
only endpoint that actually rejected an NPC was `create`, and that is the one
that changed.

## 2. Eligibility

```
GET /api/game/tryout/eligibility?userId=<robloxUserId>
```

```json
{
  "ok": true,
  "eligible": true,
  "robloxId": "123",
  "username": "EthanCaaden",
  "checks": {
    "discordLinked": true,
    "metPending": true,
    "blacklisted": false,
    "multiAccount": false,
    "multiAccountDetail": null
  },
  "undetermined": [],
  "reasons": []
}
```

A trainee who has linked Discord but is not in the MET group yet, on a portal
with no group cookie set, gets the same shape with `"metPending": null`,
`"undetermined": ["metPending"]`, `"eligible": true` and no reasons: we cannot
see their join request, so we do not turn them away over it.

`reasons` is plain English and safe to show verbatim.

What is genuinely determinable:

| check | determinable | how |
|---|---|---|
| discordLinked | when the portal database answers | portal records plus a RoVer reverse lookup |
| blacklisted | always | cases, MET punishments and account flags, resolved across every Discord account linked to the Roblox id |
| metPending | group membership always, join requests only with a group cookie | public group membership, plus the MET join request list when `ROBLOX_COOKIE` is set |
| multiAccount | when the portal database answers | see below |

Every check is three valued: `true`, `false`, or `null` for "could not tell".
`undetermined` lists the key of each check that came back `null`, using the same
names as `checks`, so `undetermined` and `checks` can never disagree and
`undetermined.includes("metPending")` means exactly `checks.metPending == nil`.

`metPending` is `true` if the trainee is in the MET group or has a pending join
request, `false` only when both halves definitively say no, and `null`
otherwise. With no `ROBLOX_COOKIE` set, a trainee who is not yet in the group
reads as `null`, never `false`: we cannot see join requests without the cookie,
so we do not claim they have none.

`discordLinked` is `false` only when the portal database answered and held no
link. If that lookup fails, it is `null` rather than `false`, because a database
blip must not send a correctly linked trainee away to re-link.

`eligible` is computed so that `null` never fails a trainee. It is true unless
something is definitely wrong.

## 3. Multi account

`multiAccount` is true when either is true:

* this Roblox account is linked to more than one Discord account
* the Discord account linked here is also linked to another Roblox account

It is `false` when both lookups ran and found nothing, and `null` when a lookup
failed, so a clean account and an unreadable one stay distinguishable.

`multiAccountDetail` is a sentence naming which. It never affects `eligible`,
it travels through to the tryout log as a flag, and a human decides.

## 4. Automated results

A dedicated endpoint, so the existing conclude contract is untouched.

```
POST /api/game/tryout/automated
```

Body is exactly the shape in your section 5. `sessionId` is optional and
defaults to `privateServerId` for idempotency: posting the same session twice
returns the first record rather than double logging.

```json
{ "ok": true, "id": "uuid", "logged": true, "why": null }
```

`logged` is false with a `why` when the log channel is unset or the bot is
offline. The record is still stored, so nothing is lost.

Rejected with 400: a missing `attendee.userId`, or a `result` that is not
`passed`, `failed` or `kicked`.

`startedAt` and `endedAt` accept an ISO string, epoch seconds (what `os.time()`
gives you) or epoch milliseconds, as a number or a string. Anything unreadable
is stored as null and the embed shows the time as unknown: a stamp we cannot
parse never costs you the record it came with.

### Keep the tryout alive while it runs

A tryout that sends no callback at all for `tryoutAbsenceMinutes` (twenty by
default, and reported by `GET /api/game/health`) is treated as abandoned: it is
set to CANCELLED, its Discord announcement is deleted and its scheduled event is
removed. That check does not care whether the host is a person or an NPC, so an
automated tryout has to keep checking in the same way a hosted one does.

Any of the existing callbacks resets the clock, so a live snapshot, a serverlock
update or a heartbeat all count. Send one every few minutes and a long tryout
will never be cancelled out from under itself. For an NPC host there is no
Roblox id to look for in the roster, so the callback alone is taken as proof the
server is still there.

## 5. The log embed

Title, trainee with id, result, quiz score, host, co host, strike count,
strike reasons, any flags, the run window as Discord timestamps, the MET crest
as thumbnail when `MET_CREST_URL` is set, and a footer marking it automated.

Buttons appear on a pass only. On a fail or a removal there is nothing to
action, so the embed carries no buttons.

* `Approve and rank` ranks the trainee to the MET entry rank
* `Reject` marks it not actioned

Both are gated to role `1426660644093952281`, or Instructor and above in the
HPC group, or a portal developer. The HPC group id comes from the portal's own
division config, so it is `35685825` unless `GROUP_HPC` overrides it. Anyone else gets an ephemeral refusal
and nothing changes. The first click wins: the record stores who clicked and
when, the embed is edited to name them, and both buttons go disabled, so the
same pass cannot be ranked twice.

If the rank change itself fails, nothing is recorded and the buttons stay live
so it can be retried.

## 6. Public directory

`https://slrmet.com/tryout`

Signed in with Discord. Shows each requirement with the failed ones spelled
out, and a start button only when eligible. Starting returns:

```json
{ "ok": true, "placeId": "111602481402239", "launchData": { "d": "HPC" }, "link": "https://www.roblox.com/games/start?placeId=...&launchData=..." }
```

`launchData` is the JSON blob form your `TryoutJoinRouter` already reads. Only
`d` is set, because the reserved server does not exist until the game makes it.
Add `c` and `t` yourself if you would rather the portal pre allocated.

## 7. Environment

Nothing is required. Every value below has a working default.

```
AUTOMATED_TRYOUT_LOG_CHANNEL_ID=   falls back to HPC_TRYOUT_LOG_CHANNEL_ID
TRYOUT_RANKER_ROLE_ID=             defaults to 1426660644093952281
HPC_INSTRUCTOR_MIN_RANK=           defaults to 100
MET_ENTRY_RANK_NAME=               defaults to PCSO
MET_CREST_URL=                     no thumbnail when unset
TRYOUT_JOIN_PLACE_ID=              defaults to 111602481402239
ROBLOX_COOKIE=                     without it the pending half of metPending is null
```

## 8. Migrations

`0081` makes the tryout host nullable and adds `automated` and `hostKind`.
`0082` adds the `automated_tryouts` table. Run `npm run db:migrate`.
