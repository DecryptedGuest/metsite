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
GET /api/game/tryout/eligibility?userId=<robloxUserId>&hint=<urlencoded string>
```

```json
{
  "ok": true,
  "eligible": true,
  "robloxId": "3439167760",
  "username": "realangeloo",

  "identity": {
    "resolved": true,
    "matchedBy": "nickname",
    "discordId": "000000000000000000",
    "discordUsername": "someone",
    "discordNickname": "PC 442 | realangeloo"
  },

  "checks": {
    "inMetServer": true,
    "metPending": true,
    "blacklisted": false,
    "multiAccount": false,
    "multiAccountDetail": null
  },

  "undetermined": [],
  "reasons": []
}
```

The rule is membership of the MET Discord server. `checks.discordLinked` is
gone: nobody has to have signed into the portal.

### How somebody is recognised

We resolve the Roblox username for the id, then look for a member of the MET
server whose **server nickname** carries that username. Nicknames read
`PC 442 | realangeloo`, so the username has to be one of the nickname's own
tokens. Tokens are split on everything that is not a letter, a digit or an
underscore, because Roblox usernames contain underscores and nothing else.

That token rule is what stops a short username swallowing half the server:
`bob` does not match `PC 1 | bobby`.

| what we find | identity.resolved | checks.inMetServer |
|---|---|---|
| exactly one nickname carries it | `true`, matchedBy `nickname` | `true` |
| no nickname carries it | `false` | `null`, listed in `undetermined` |
| more than one carries it | `false` | `null`, listed in `undetermined` |
| Discord unreachable | `false` | `null`, listed in `undetermined` |

Two of those deserve saying plainly. **No match is not the same as not a
member**: they may well be in the server under a nickname we cannot read, so it
is `null` rather than `false` and the game prompts them. And a member with **no
nickname set at all** cannot be recognised this way, by design; the hint is what
rescues them.

`inMetServer` is only ever `false` for a signed in portal user we can identify
exactly and who is genuinely not in the server. The game never sees that case.

### The hint

When `identity.resolved` came back `false`, ask the player who they are on
Discord and call again with `&hint=`. It takes a username, a global display
name, a server nickname or a raw user id, is treated as untrusted free text and
is cut to 64 characters.

The hint finds candidates. **It never vouches for them.** Whoever it finds still
has to have the caller's Roblox username in their nickname, or anyone could
name a member and be treated as them. A hint that lands on a member whose
nickname does not carry it comes back `resolved: false` with:

> That Discord account does not have your Roblox username in its nickname in the MET server.

`matchedBy` is `"hint"` on a hint match, `"nickname"` on a plain one, and
`"session"` for a signed in portal user, which the game will never see because
the game never sends a Discord id.

### The Discord picture

`identity` also carries two fields for the confirmation card:

| field | type | meaning |
|---|---|---|
| discordAvatarAssetId | number or null | a Roblox asset id, ready for `rbxassetid://` |
| discordAvatarUrl | string or null | the Discord cdn url, for the site's own UI |

`discordAvatarAssetId` is a number **only once Roblox has approved the image**.
It is null in every other case: nothing held yet, still in review, refused,
refused by our own checks, or no credential configured. An id that is still in
review renders as nothing in game, so handing it over would show a broken image
where your fallback logo belongs. Treat null as "use the logo" and nothing else.

Expect null the first time somebody tries out. The picture is uploaded in the
background when the eligibility check runs, Roblox moderation takes as long as
it takes, and the endpoint never waits for it. So the avatar appears on a later
attempt, not the one that triggered it.

A server specific avatar is preferred over the account one. Animated avatars are
declined: Discord serves those as a gif and a Decal is a still image.

Not every member gets a picture, on purpose. Re-hosting makes our Roblox account
the publisher of somebody else's image, and Roblox moderation acts on the
publisher, so an upload only happens for a member who has been in the MET server
for at least `DISCORD_AVATAR_MIN_DAYS` (default 7), whose picture is a real png
under `DISCORD_AVATAR_MAX_BYTES`, while the day's `DISCORD_AVATAR_MAX_PER_DAY`
ceiling has room. Anything Roblox refuses is never sent again.
`DISCORD_AVATAR_REHOST=off` stops every upload at once while still serving what
is already approved.

### Three valued checks

Every check is `true`, `false`, or `null` for "could not tell". `undetermined`
lists the key of each one that came back `null`, using the same names as
`checks`, so the two can never disagree and `undetermined.includes("metPending")`
means exactly `checks.metPending == nil`.

| check | determinable | how |
|---|---|---|
| inMetServer | when the bot can read the member list | nickname match, or the hint path |
| blacklisted | always | cases, MET punishments and account flags, across every Discord account we can tie to the Roblox id |
| metPending | group membership always, join requests only with a group cookie | public group membership, plus the MET join request list when `ROBLOX_COOKIE` is set |
| multiAccount | when the portal database answers | see below |

`metPending` is `true` if the trainee is in the MET group or has a pending join
request, `false` only when both halves definitively say no, and `null`
otherwise. With no `ROBLOX_COOKIE` set, a trainee who is not yet in the group
reads as `null`, never `false`: we cannot see join requests without the cookie,
so we do not claim they have none.

`eligible` is our own verdict, computed so that `null` never fails anybody: it
is true unless something is definitely wrong. The game is stricter than that on
purpose and fails closed on anything it could not confirm, which is the right
way round.

### reasons

Spoken aloud by the instructor, in order, whenever the tryout is refused. Whole
sentences addressed to the player, plain text, and no dash of any kind anywhere
in them. A test asserts that last part, so it stays true.

The member list is cached for five minutes, so the two calls a tryout attempt
makes cost one Discord fetch at most.

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

Body is exactly the shape in your section 5.

`sessionId` is optional and identifies THIS TRAINEE'S result, not the server it
happened in. Left out, it is built from `privateServerId` and
`attendee.userId`, because one reserved server runs several trainees one after
another: keying on the server alone made the second and third look like retries
of the first, so their results were never recorded, nobody could rank them, and
the panel got a 200 either way. Posting the same trainee's result twice still
returns the first record rather than logging it again.

Send your own `sessionId` if you want a trainee to be able to sit a second
tryout in the same reserved server, since the composed key would treat that as
a repeat.

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
* `Reject` records it as rejected and names who did it

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

Two of these decide whether the feature does anything visible. The rest have
working defaults.

```
AUTOMATED_TRYOUT_LOG_CHANNEL_ID=   falls back to HPC_TRYOUT_LOG_CHANNEL_ID
ROBLOX_COOKIE=                     a MET group cookie
TRYOUT_RANKER_ROLE_ID=             defaults to 1426660644093952281
HPC_INSTRUCTOR_MIN_RANK=           defaults to 100
MET_ENTRY_RANK_NAME=               defaults to PCSO
MET_CREST_URL=                     no thumbnail when unset
TRYOUT_JOIN_PLACE_ID=              defaults to 111602481402239
TRYOUT_HOST_ABSENCE_MINUTES=       defaults to 20
DISCORD_AVATAR_REHOST=             set to off to stop re-hosting avatars
DISCORD_AVATAR_MIN_DAYS=           defaults to 7
DISCORD_AVATAR_MAX_PER_DAY=        defaults to 25
DISCORD_AVATAR_MAX_BYTES=          defaults to 1048576
```

Re-hosting avatars also needs the Open Cloud credential set in the dev panel,
with the Assets API granted read AND write, created under whoever owns the
experience. Without it the two avatar fields simply stay null.

With no log channel set, in either variable, the tryout is still recorded and
the response says `logged: false` with the reason, but no embed and no buttons
appear anywhere. That reads exactly like the feature being broken, so set it
first.

The group cookie does two jobs. Without it the join request half of
`metPending` cannot be read, so a trainee who has applied but not been accepted
comes back `null` rather than `false` and stays eligible. And `Approve and rank`
cannot move anybody: it answers with the reason, records nothing, and leaves the
buttons live so it can be pressed again once the cookie is set.

## 8. Migrations

`0081` makes the tryout host nullable and adds `automated` and `hostKind`.
`0082` adds the `automated_tryouts` table.
`0083` adds `discord_avatar_assets`, the re-hosted picture cache.
Run `npm run db:migrate`.
