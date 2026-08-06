# MET dashboard — working notes

## House style

**Never use an em dash (—) in anything a user sees** — Discord messages, embed
titles/descriptions/fields, button labels, DMs, and website copy. The owner
dislikes it (it "looks AI"). Use a colon, a comma, a full stop, brackets, or the
app's own middot separator "·" instead, and reword rather than reach for a dash.
This applies to all new and edited user-facing text. Plain hyphens in ordinary
words ("co-host", "3-4 digit", "sign-in") are fine — it is the long dash as a
sentence/label separator that is out.

Note: em dashes that appear **inside a regex** (e.g. parsing "21 July — 4 August"
ranges in loaImport, or dash normalisation in forumImport) are matching real
input and must be left alone.
