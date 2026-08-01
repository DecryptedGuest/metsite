# Roblox → site game-log ingest

Point your training/tryout game's existing Adonis / join / leave / chat webhook
scripts at the site instead of (or in addition to) Discord. The site stores them
and shows them to MET High Command under **HICOMM dashboard → Game Logs**.

## Endpoint

```
POST https://metsite-production.up.railway.app/api/game/log
Headers:
  Content-Type: application/json
  x-game-secret: <TRYOUT_GAME_SECRET>   ← same secret the tryout callbacks already use
```

Auth is the same shared secret as the other `/api/game/*` callbacks
(`TRYOUT_GAME_SECRET`), so nothing new to configure server-side.

## Payload

Send **one event** or a **batch** (`{ "logs": [ ... ] }`, max 200). Every field
is optional and tolerant of aliases — send whatever your script already has:

| Field     | Aliases accepted                              | Meaning                          |
|-----------|-----------------------------------------------|----------------------------------|
| `source`  | `type`, `kind`                                | `ADONIS` \| `JOIN` \| `LEAVE` \| `CHAT` (default ADONIS) |
| `actor`   | `player`, `admin`, `username`, `from`, `user` | who did it / who joined / speaker |
| `actorId` | `playerId`, `userId`, `adminId`               | actor's Roblox user id           |
| `target`  | `victim`, `targetName`                        | who an admin command hit         |
| `action`  | `command`, `cmd`                              | e.g. `Kick`, `Ban`, `Warn`       |
| `message` | `reason`, `text`, `chat`, `content`           | chat text / admin reason         |
| `place`   | `placeName`, `server`, `jobId`                | server label                     |

## Roblox prompt (hand this to whoever manages the game)

> In our training/tryout Roblox game, add an HTTP log forwarder that POSTs to
> `https://metsite-production.up.railway.app/api/game/log` with header
> `x-game-secret: <TRYOUT_GAME_SECRET>` and a JSON body. Fire it from four places:
> **(1) Player join** — `Players.PlayerAdded` → `{source:"JOIN", actor:player.Name, actorId:player.UserId}`.
> **(2) Player leave** — `Players.PlayerRemoving` → `{source:"LEAVE", actor:player.Name, actorId:player.UserId}`.
> **(3) Chat** — `player.Chatted` → `{source:"CHAT", actor:player.Name, actorId:player.UserId, message:msg}`.
> **(4) Adonis admin log** — hook Adonis's logging (or its Discord-webhook call) and forward
> `{source:"ADONIS", actor:<admin>, target:<target>, action:<command>, message:<reason>}`.
> Batch with `{logs:[...]}` if you buffer. Use `HttpService:JSONEncode`, wrap in `pcall`,
> and keep the existing Discord webhooks if you want both.

### Minimal Lua example

```lua
local HttpService = game:GetService("HttpService")
local Players = game:GetService("Players")
local URL = "https://metsite-production.up.railway.app/api/game/log"
local SECRET = "PUT_TRYOUT_GAME_SECRET_HERE"

local function sendLog(data)
    pcall(function()
        HttpService:RequestAsync({
            Url = URL, Method = "POST",
            Headers = { ["Content-Type"] = "application/json", ["x-game-secret"] = SECRET },
            Body = HttpService:JSONEncode(data),
        })
    end)
end

Players.PlayerAdded:Connect(function(p)
    sendLog({ source = "JOIN", actor = p.Name, actorId = p.UserId })
    p.Chatted:Connect(function(msg)
        sendLog({ source = "CHAT", actor = p.Name, actorId = p.UserId, message = msg })
    end)
end)
Players.PlayerRemoving:Connect(function(p)
    sendLog({ source = "LEAVE", actor = p.Name, actorId = p.UserId })
end)

-- For Adonis: call sendLog({source="ADONIS", actor=admin, target=target, action=cmd, message=reason})
-- from wherever Adonis currently posts its Discord log.
```

> Note: Roblox `HttpService` must have "Allow HTTP Requests" enabled in game
> settings, and outbound HTTP only works in the live game (not Studio without it).
