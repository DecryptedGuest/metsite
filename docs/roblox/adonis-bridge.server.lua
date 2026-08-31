--!strict
-- MET · Adonis command bridge (server script)
--
-- Put this in ServerScriptService of every game that should be reachable from
-- the site and from /adonis in Discord.
--
-- It replaces the script written against the old standalone bridge. What
-- changed: the base URL is the MET site rather than a separate service, and
-- the shared secret is the one you already set for the site (GAME_SECRET), so
-- there is no second token to keep in step. The old AUTH_TOKEN is gone.
--
-- Setup, once:
--   1. Game Settings → Security → Allow HTTP Requests: ON
--   2. Set BASE_URL below to your site.
--   3. Put the same value as the site's GAME_SECRET into a
--      ServerStorage StringValue named "MET_GAME_SECRET", or paste it into
--      SECRET below. The StringValue is better: it keeps the secret out of
--      the script, so it does not travel with a copied place file.

local HttpService     = game:GetService("HttpService")
local Players         = game:GetService("Players")
local ServerStorage   = game:GetService("ServerStorage")
local Teams           = game:GetService("Teams")
local RunService      = game:GetService("RunService")

local BASE_URL = "https://YOUR-MET-SITE.example.com/api/adonis"
local SECRET   = ""            -- or leave empty and use the StringValue below

do
	local sv = ServerStorage:FindFirstChild("MET_GAME_SECRET")
	if sv and sv:IsA("StringValue") and sv.Value ~= "" then SECRET = sv.Value end
end

local HEARTBEAT_SECONDS = 15   -- the site treats a server as gone after 60s
local RETRY_BACKOFF     = { 2, 5, 15, 30 }   -- seconds, then it stays at 30

if RunService:IsStudio() then
	warn("[MET] Adonis bridge is running in Studio; heartbeats will still be sent.")
end
if SECRET == "" then
	warn("[MET] No game secret set. The bridge will not start.")
	return
end

-- ── HTTP ────────────────────────────────────────────────────────────────
local function request(method: string, path: string, body: any): (boolean, any)
	local ok, res = pcall(function()
		return HttpService:RequestAsync({
			Url = BASE_URL .. path,
			Method = method,
			Headers = {
				["Content-Type"]   = "application/json",
				["x-game-secret"]  = SECRET,
			},
			Body = body and HttpService:JSONEncode(body) or nil,
		})
	end)
	if not ok then return false, res end
	if not res.Success then return false, `HTTP {res.StatusCode}: {res.Body}` end
	local decoded
	local decodedOk = pcall(function() decoded = HttpService:JSONDecode(res.Body) end)
	return true, decodedOk and decoded or nil
end

-- ── Who is in this server ───────────────────────────────────────────────
-- Sent with every heartbeat, so the site and Discord can answer "who is in
-- this server" and "what team is everyone on" without a second round trip.
local function snapshot()
	local list = {}
	for _, p in ipairs(Players:GetPlayers()) do
		local rank: string? = nil
		-- Adonis exposes the caller's admin level; if you rank by group, put
		-- the group rank name here instead.
		local level: number? = nil
		local adonisOk, adonis = pcall(function()
			return _G.Adonis or (server ~= nil and server) or nil
		end)
		if adonisOk and adonis and adonis.Admin and adonis.Admin.GetLevel then
			local lok, lv = pcall(adonis.Admin.GetLevel, p)
			if lok then level = lv end
		end
		table.insert(list, {
			userId      = tostring(p.UserId),
			name        = p.Name,
			displayName = p.DisplayName,
			team        = p.Team and p.Team.Name or nil,
			rank        = rank,
			adminLevel  = level,
		})
	end
	return list
end

-- ── Run what the site sent ──────────────────────────────────────────────
local function runCommand(entry)
	local text = entry.command
	if type(text) ~= "string" or text == "" then return false, "empty command" end

	-- Adonis' own entry point. Run as the server, at the highest level, since
	-- the site has already decided who was allowed to ask for this.
	local ok, err = pcall(function()
		local adonis = _G.Adonis or (server ~= nil and server) or nil
		if not adonis then error("Adonis is not loaded in this place") end
		if adonis.Admin and adonis.Admin.RunCommandAsNonAdmin then
			adonis.Admin.RunCommand(text)
		elseif adonis.Commands then
			adonis.Admin.RunCommand(text)
		else
			error("no Adonis command entry point found")
		end
	end)
	return ok, ok and "ok" or tostring(err)
end

local function handle(commands)
	if type(commands) ~= "table" then return end
	for _, entry in ipairs(commands) do
		local ok, output = runCommand(entry)
		task.spawn(function()
			request("POST", `/commands/{entry.id}/ack`, {
				serverId = game.JobId,
				ok = ok,
				output = output,
			})
		end)
	end
end

-- ── The loop ────────────────────────────────────────────────────────────
task.spawn(function()
	local failures = 0
	while true do
		local ok, res = request("POST", "/heartbeat", {
			serverId    = game.JobId,
			placeId     = tostring(game.PlaceId),
			placeName   = nil,               -- set this if you want a friendly name
			playerCount = #Players:GetPlayers(),
			maxPlayers  = Players.MaxPlayers,
			players     = snapshot(),
		})

		if ok then
			failures = 0
			-- The heartbeat answers with anything waiting, so there is no
			-- separate poll in the normal case.
			if res and res.commands then handle(res.commands) end
		else
			failures += 1
			local wait = RETRY_BACKOFF[math.min(failures, #RETRY_BACKOFF)]
			warn(`[MET] heartbeat failed ({res}); retrying in {wait}s`)
			task.wait(wait)
			continue
		end

		task.wait(HEARTBEAT_SECONDS)
	end
end)

-- Tell the site the moment the server goes, rather than leaving it to time out.
game:BindToClose(function()
	request("POST", "/shutdown", { serverId = game.JobId })
	task.wait(0.5)
end)

print("[MET] Adonis bridge running · job " .. game.JobId)
