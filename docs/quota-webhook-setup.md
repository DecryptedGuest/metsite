# Quota Webhook Setup — per‑division tutorials

This is the setup guide for the **Apps Script quota webhook** (`scripts/quota-webhook.gs`).
The webhook is what lets the MET site add a point to a division's Google Sheet when
something is approved:

| Approval | Points added |
|----------|:------------:|
| Case approved | **+4** |
| Ticket approved | **+2** |
| Event log approved | **+1** |

There is **one deployment per division sheet**. The same script file is used for
every division — only the three settings at the top (`SECRET`, `SHEET_NAME`,
`TIMEZONE`) and the Railway env vars differ. The script is *bound* to the sheet
you paste it into, so it already has edit access — no service account, no API
enabling, no sharing.

Every database in this guide has a **different layout**, so each division gets
its own section below telling you exactly what to put in `SHEET_NAME` and how to
make sure your columns are detected.

---

## How the webhook finds the right cell (read this once)

The script does **not** use fixed column letters. It scans the tab(s) for
**header cells** and matches them by name:

* **Member column** — a header cell reading `USERNAME`, `Roblox Username`,
  `Roblox User`, `Roblox`, or `User`, **and/or** a `Discord ID` / `Discord`
  column. Either one is enough to find the member; if both exist, the Discord ID
  is tried first (most reliable).
* **Day columns** — seven header cells that **start with a day name**: `Mon`,
  `Tue`, `Wed`, `Thu`, `Fri`, `Sat`, `Sun` (full names like `Monday` work too).
  The point lands in **today's** column (in the sheet's `TIMEZONE`).

> ⚠️ **The single most important requirement:** each of the seven day columns
> must have its **own header cell** that starts with a day name. If your sheet
> only has a merged section banner like `EVENTS ATTENDED` or `Quota Points`
> sitting *above* seven unlabelled columns, the script can't find the days. Put
> `Mon Tue Wed Thu Fri Sat Sun` in the row directly under the banner (a second
> header row is fine — the scanner reads the whole grid, not just row 1).

Everything else on the sheet — RANK, STRIKE, TOTAL, DIVISION, TIMEZONE columns,
disciplinary tables, etc. — is **ignored** by the webhook. You don't need to
move or rename them.

### Multi‑tab databases

Some databases split their members across several tabs (e.g. one tab per rank).
`SHEET_NAME` controls which tabs are searched:

| `SHEET_NAME` value | Meaning |
|--------------------|---------|
| `'Staff'` | search **one** tab called `Staff` |
| `''` (empty) | search **every** tab in the spreadsheet |
| `'Low Rank, Middle Rank, High Rank'` | search **these tabs, in order** (skip everything else) |

The member is written to the **first** tab they're found in. `reset` and
`exempt` actions apply to **all** searched tabs. Use the comma‑separated form
when the spreadsheet also has non‑personnel tabs (an `LOA` tab, an `Analytics`
tab) that you don't want touched.

---

## Universal setup steps (every division)

1. Open the division's quota Google Sheet.
2. **Extensions → Apps Script**. Delete anything there, paste the whole of
   `scripts/quota-webhook.gs`.
3. Set the three values at the top:
   * `SECRET` — a long random string. **Use a different one per division.**
   * `SHEET_NAME` — see the per‑division section below.
   * `TIMEZONE` — leave as `Europe/London` unless the division tracks a
     different day boundary.
4. **Deploy → New deployment → Web app**
   * *Execute as:* **Me**
   * *Who has access:* **Anyone**
   * Deploy, authorise, and **copy the Web app URL** (ends in `/exec`).
5. Visit that `/exec` URL in a browser — you should see
   `{"ok":true,"service":"IACMS quota webhook","ready":true}`.
6. In **Railway**, set the two variables for that division (names are in each
   section below) to the `/exec` URL and the same `SECRET`.

To test end‑to‑end: approve a case/ticket for a member you can see, then refresh
the sheet — today's column on their row should go up by 4/2. The site's
**Quota Check** tab also shows a per‑member breakdown once the webhook is live.

---

## LOA / exemptions (how they're handled)

The site handles LOA/exemption **itself** through the Quota Check tab's
*LOA / Exempt* action. When you mark a member exempt, the webhook writes `EX`
into every day cell on their row, and the weekly **reset** leaves those `EX`
markers in place (so they aren't dinged for that week). The engine also treats
any rank containing `loa` or `director` as automatically exempt.

That means a **separate LOA tab in the spreadsheet** (like SCO‑19's) is **not
read** by the webhook — it's your own record‑keeping. Keep the LOA tab out of
`SHEET_NAME` (use the comma‑separated personnel‑tab list) so `reset`/`exempt`
never touch it.

---

## FLP — Frontline Policing

* **Spreadsheet:** *Frontline Policing Database*
* **Tab:** `Frontline Police Database` (single personnel tab)
* Columns seen: `USERNAME` (F), `RANK` (G), day columns **Mon–Sun (H–N)**,
  `TOTAL` (O), `FQ STRIKE`/flag (P). Two sections (FLP Management, Frontline
  Policing Personnel) live in the same tab — that's fine, both are scanned.

```
SECRET     = '<unique-random-string-FLP>'
SHEET_NAME = 'Frontline Police Database'
TIMEZONE   = 'Europe/London'
```

**Railway env:**
```
FLP_QUOTA_WEBHOOK_URL    = <the /exec URL>
FLP_QUOTA_WEBHOOK_SECRET = <the same SECRET>
FLP_SHEET_ID             = <the spreadsheet id from its URL>
FLP_QUOTA_SHEET_NAME     = Frontline Police Database   # optional; must match the tab
```

**Rank targets** — set `FLP_QUOTA_TARGETS` (JSON) so the Quota Check tab knows
each rank's weekly requirement. Example (adjust the numbers to your real quota):
```json
[
  { "match": "overseer|director",          "exempt": true, "tier": "Management" },
  { "match": "comm|csup|superintendent",   "target": 3,    "tier": "Command" },
  { "match": ".*",                          "target": 5,    "tier": "Personnel" }
]
```
Rules are tried top‑to‑bottom; the first regex that matches the member's rank
wins. Any `director`/`loa` rank is exempt automatically even without a rule.

**Event points:** an approved **event log** adds **+1** to FLP. This is already
wired — set `EVENT_POINT_TARGET=FLP` (or `BOTH` to also credit MET). Event logs
can only be approved by **FLP HICOMM** (`FLP_HICOMM_MIN_RANK`).

---

## MET — Metropolitan Police Service (main quota)

* **Spreadsheet:** *Metropolitan Police Service | Database*
* **Tabs:** `Chief Inspector`, `Inspector`, `Sergeant`, `Constable`
  (members are split by rank across these tabs)
* Columns seen on each tab: `USERNAME` (D), `RANK` (E), `ACTIVITY STRIKE` (F),
  an `EVENTS ATTENDED` section over day columns **Mon–Sun (H–N)**, `TOTAL` (O).

Because members are spread across four rank tabs, search **all** of them:

```
SECRET     = '<unique-random-string-MET>'
SHEET_NAME = 'Chief Inspector, Inspector, Sergeant, Constable'
TIMEZONE   = 'Europe/London'
```
(You could also use `SHEET_NAME = ''` to search every tab, but listing the four
personnel tabs explicitly avoids touching any summary/analytics tab.)

> ⚠️ **Check the `EVENTS ATTENDED` header.** The webhook needs the seven day
> columns (H–N) to each be headed `Mon … Sun`. If `EVENTS ATTENDED` is a single
> merged banner with blank cells under it, add a `Mon Tue Wed Thu Fri Sat Sun`
> row directly beneath it, or the day can't be located.

**Railway env:**
```
MET_QUOTA_WEBHOOK_URL    = <the /exec URL>
MET_QUOTA_WEBHOOK_SECRET = <the same SECRET>
MET_SHEET_ID             = <the spreadsheet id>
# MET tracks per-rank tabs, so leave MET_QUOTA_SHEET_NAME BLANK
#   (SHEET_NAME lives in the Apps Script, which already lists the tabs)
MET_QUOTA_TARGETS        = <JSON, same shape as FLP above>
```

MET quota/activity is reviewable from the **FLP dashboard → “MET Quota Review”**
tab (FLP reviews MET), and event logs credit MET when `EVENT_POINT_TARGET` is
`MET` or `BOTH`.

---

## SCO‑19 — Specialist Firearms Command

* **Spreadsheet:** *SCO‑19 Database*
* **Tabs:** `Specialist Firearms Command` (personnel + points) and a separate
  `LOA` tab (record‑keeping only — **not** searched).
* SFC tab columns seen: a `PERSONNEL INFORMATION` block with `USERNAME` (D) and
  `DIVISION RANK` (E), strike/`EX`/`SUSP`/`LOA`/`RH`/`IQE`/`DQE`/`BQE` markers
  (F–N), then a `POINTS INFORMATION` block over day columns **Mon–Sun (P–V)**
  and `TOTAL` (W).
* LOA tab columns seen (informational): `USERNAME` (A), `APPROVED` (B),
  `REASON` (D), `START` (G), `END` (H), `LENGTH` (I), `LEAVE IT` (K).

Search only the personnel tab so the LOA tab is never modified:

```
SECRET     = '<unique-random-string-SCO19>'
SHEET_NAME = 'Specialist Firearms Command'
TIMEZONE   = 'Europe/London'
```

> ⚠️ Same check as MET: the seven columns under `POINTS INFORMATION` (P–V) must
> each be headed with a day name. Add a `Mon … Sun` row under the banner if they
> aren't already.

**Railway env — see the caveat below.** SCO‑19 is **not yet a first‑class
division in the quota engine** (only IA, FLP and MET have their own env prefix).
The webhook script and sheet are ready; wiring SCO‑19's own `SCO19_*` env prefix
into `server/lib/quota.js` (`DIVISION_PREFIX`) is a small follow‑up. **Tell me to
enable SCO‑19 (and give me its rank→target list) and I'll add the prefix + a
Quota Check tab for it.** Until then, deploy the webhook and keep the `/exec` URL
+ secret handy.

---

## CID — Criminal Investigation Department

* **Spreadsheet:** *CID Database*
* **Tabs:** `Low Rank`, `Middle Rank`, `High Rank` (members split by rank tier)
* Low Rank tab columns seen: `#` (D), `USERNAME` (E), `RANK` (F, e.g. a
  *Detective Constable* dropdown), `TIMEZONE` (G), `SUSPENDED` (H), a
  `Quota Points` section over day columns **Mon–Sun (J–P)**, `TOTAL` (Q), and a
  `DIVISION` block (`IC`/`DC`/`IA`/`EX`, R–U).

Search the three rank tabs:

```
SECRET     = '<unique-random-string-CID>'
SHEET_NAME = 'Low Rank, Middle Rank, High Rank'
TIMEZONE   = 'Europe/London'
```

> ⚠️ Same check: the seven columns under `Quota Points` (J–P) must each be
> headed `Mon … Sun`.

**Railway env — same caveat as SCO‑19.** CID isn't in the quota engine's
`DIVISION_PREFIX` yet. Deploy the webhook now; tell me to enable CID (with its
rank→target list) and I'll add a `CID_*` prefix + Quota Check tab.

---

## IA — Internal Affairs (reference / already live)

Included for completeness — IA is the original, unprefixed configuration.

* **Tab:** typically `Staff`
* `SHEET_NAME = 'Staff'`

**Railway env (no prefix):**
```
QUOTA_WEBHOOK_URL    = <the /exec URL>
QUOTA_WEBHOOK_SECRET = <the same SECRET>
QUOTA_SHEET_ID       = <spreadsheet id>   # optional; defaults to the IA database
QUOTA_SHEET_NAME     = Staff              # optional
QUOTA_TIMEZONE       = Europe/London      # optional
```
IA rank targets come from the built‑in IA rank table (`quotaForRank`), so no
`*_QUOTA_TARGETS` is needed.

---

## Env var quick reference

| Division | Prefix | Webhook URL var | Secret var | Sheet ID var | Targets var |
|----------|:------:|-----------------|------------|--------------|-------------|
| IA  | *(none)* | `QUOTA_WEBHOOK_URL` | `QUOTA_WEBHOOK_SECRET` | `QUOTA_SHEET_ID` | built‑in |
| FLP | `FLP_` | `FLP_QUOTA_WEBHOOK_URL` | `FLP_QUOTA_WEBHOOK_SECRET` | `FLP_SHEET_ID` | `FLP_QUOTA_TARGETS` |
| MET | `MET_` | `MET_QUOTA_WEBHOOK_URL` | `MET_QUOTA_WEBHOOK_SECRET` | `MET_SHEET_ID` | `MET_QUOTA_TARGETS` |
| SCO‑19 | *(needs enabling)* | — | — | — | — |
| CID | *(needs enabling)* | — | — | — | — |

Also relevant: `EVENT_POINT_TARGET` (`FLP` / `MET` / `BOTH`) for where an
approved event log's +1 lands; `QUOTA_TIMEZONE` / `<PREFIX>QUOTA_TIMEZONE` for
the day boundary.

---

## Troubleshooting

* **`member not found`** — the member's name on the sheet doesn't match their
  Roblox username/Discord ID. Matching is case/space/underscore‑insensitive, but
  if they've been renamed, add their current Roblox username to the sheet, or add
  a `Discord ID` column (most reliable).
* **`day column not found for <day>`** — the seven day headers aren't detected on
  the tab the member is on. Add a `Mon … Sun` header row under the section banner.
* **`cell is non-numeric (EX) — left untouched`** — the member is marked exempt
  (`EX`) for that day; the webhook won't overwrite an exemption. Expected.
* **`no username/discord column found`** — that tab has no `USERNAME`/`Discord`
  header; make sure `SHEET_NAME` lists the personnel tabs, not summary tabs.
* **Points not appearing but no error** — check the `/exec` URL in Railway matches
  the *latest* deployment. Every time you edit the Apps Script you must
  **Deploy → Manage deployments → Edit → Version: New version**, or redeploy.
