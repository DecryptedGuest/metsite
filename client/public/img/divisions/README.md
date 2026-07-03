# Division / MET logos

Drop the group logos here and the site uses them directly (they take priority
over the live Roblox group icon, which is unreliable). Use whatever image format
you have — `.png`, `.jpg`, `.jpeg`, `.webp`, `.svg`, or `.gif`.

Name each file after its slug:

| File to add            | Group / entity            | Roblox group |
|------------------------|---------------------------|--------------|
| `met.<ext>`            | Metropolitan Police (brand)| 17275620    |
| `cid.<ext>`            | CID                       | 12697126     |
| `sco19.<ext>`          | SCO-19                    | 14063116     |
| `ia.<ext>`             | Internal Affairs          | 407296071    |
| `flp.<ext>`            | Frontline Policing        | 233530818    |
| `hpc.<ext>`            | Hendon Police College     | 35685825     |

Example: save the CID logo as `client/public/img/divisions/cid.png`, commit, and
push. It appears on the hub cards, the profile, and the shared topbar. No code or
env change needed — the server auto-detects the file on the next deploy.
