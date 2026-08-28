# Handoff — CID Instructor panel sync (Roblox side)

The Discord half is built and running in the METAdministration bot. This is
what the game needs to do to read it.

## How it works

Discord is the source of truth for who is a CID instructor. The bot resolves
every holder of the instructor role to a **Roblox user id** and writes them into
a DataStore. The game only ever **reads** — it never calls the bot, needs no
HTTP permissions, and keeps working if the bot is offline.

```
Discord role  →  bot resolves via RoVer  →  Open Cloud  →  DataStore  →  game panel
```

Updates arrive **within ~10 seconds** of a role being added or removed
(debounced, so a bulk role edit is one write not fifty), plus a full re-sync
every 30 minutes that repairs anything a missed event left stale.

## What you are reading

| | |
|---|---|
| DataStore name | `MET_Sync`  (env `ROBLOX_DATASTORE_NAME`) |
| Scope | `global` |
| Key | `CID_Instructors`  (env `CID_INSTRUCTOR_KEY`) |
| Discord role | `1438282078356504686` in guild `1438215998338760887` |

### The stored value

```json
{
  "userIds": [123456, 789012],
  "members": [
    { "userId": 123456, "username": "SomeInstructor" },
    { "userId": 789012, "username": "AnotherOne" }
  ],
  "role": "CID Instructor",
  "syncedAt": "2026-08-28T12:34:56.789Z",
  "source": "METAdministration"
}
```

`userIds` is a plain array of numbers — check against that. `members` is only
there if the panel wants to show names.

## Reading it in game

```lua
local DataStoreService = game:GetService("DataStoreService")
local Players          = game:GetService("Players")

local STORE_NAME = "MET_Sync"
local KEY        = "CID_Instructors"
local REFRESH    = 60          -- seconds

local store = DataStoreService:GetDataStore(STORE_NAME)

local instructors = {}         -- [userId] = true
local lastSynced

local function refresh()
    local ok, data = pcall(function()
        return store:GetAsync(KEY)
    end)
    -- Keep the previous list on a failed read: a DataStore blip must not lock
    -- every instructor out of the panel.
    if not ok or type(data) ~= "table" or type(data.userIds) ~= "table" then
        warn("[CIDPanel] instructor refresh failed:", data)
        return false
    end

    local next = {}
    for _, id in ipairs(data.userIds) do
        next[tonumber(id)] = true
    end
    instructors = next
    lastSynced  = data.syncedAt
    return true
end

local function isInstructor(player)
    return instructors[player.UserId] == true
end

refresh()
task.spawn(function()
    while true do
        task.wait(REFRESH)
        refresh()
    end
end)
```

Then gate the panel with `isInstructor(player)`.

### Two things worth getting right

**Check on the server, not the client.** A LocalScript deciding who sees the
panel is trivially bypassed. Verify `isInstructor` in the server script that
actually performs whatever the panel does, on every remote call — not just when
opening the UI.

**Never fail closed on a read error.** The `pcall` above keeps the previous
list when a `GetAsync` fails. DataStore hiccups are routine; wiping the list on
one failed read means everyone loses access at once, which looks exactly like a
permissions bug and is far more disruptive than a slightly stale list.

## Setup still needed

The bot cannot write until an Open Cloud key exists. In the Creator Dashboard →
**Open Cloud → API Keys**, create a key with the **Data Stores** permission for
this universe (read + write on `MET_Sync`), then set in the bot's `.env`:

```
ROBLOX_UNIVERSE_ID=<Creator Dashboard → experience → ⋯ → Copy Universe ID>
ROBLOX_OPENCLOUD_KEY=<the key>
```

Also make sure **Studio Access to API Services** is enabled for the place, or
`GetAsync` returns nothing in Studio testing.

## Verifying end to end

1. In the CID Discord, run `/panel sync panel:CID Instructor dry:true`. This
   resolves everyone and returns the exact JSON as a file, writing nothing.
   Check the names look right.
2. Run it without `dry` to actually push.
3. Run `/panel status panel:CID Instructor` — it reads the value **back out of
   the DataStore**, so a green result proves the game will see it.
4. In game, print `instructors` after `refresh()`.

## The one failure mode to expect

Anyone holding the Discord role who has **never verified with RoVer** cannot be
resolved to a Roblox id, so they will not appear in the panel. This is reported
explicitly — `/panel sync` lists them under "No Roblox link — excluded". If an
instructor says the panel does not recognise them, that list is the first place
to look; the fix is for them to verify, not a code change.
