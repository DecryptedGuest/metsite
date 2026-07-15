#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# MET CAD Voice Worker — cloud VM auto-setup (Ubuntu/Debian)
#
# Paste this into the "cloud-init" / "user data" / "cloud config" box when you
# CREATE the VM. Works on any Ubuntu/Debian VM that accepts a cloud-init script:
#   • Hetzner Cloud → Create Server → "Cloud config" box  (recommended, cheap)
#   • Oracle Cloud  → Create Instance → Advanced → Management → Cloud-init script
#   • Google Cloud  → Create Instance → Management → Automation → Startup script
# It runs on first boot as root: installs Node, downloads the worker, and runs it
# 24/7 as a service that restarts itself and survives reboots. No terminal needed.
#
# BEFORE pasting: replace the four PASTE_… values below with your real ones.
# ─────────────────────────────────────────────────────────────────────────────

# ── FILL THESE IN ────────────────────────────────────────────────────────────
VOICE_BOT_TOKEN="PASTE_YOUR_SECOND_BOT_TOKEN"
WORKER_SECRET="PASTE_A_LONG_RANDOM_STRING"           # must equal Railway's CAD_VOICE_WORKER_SECRET
ELEVENLABS_API_KEY="PASTE_YOUR_ELEVENLABS_KEY"
CAD_MAIN_WS_URL="wss://YOUR-RAILWAY-DOMAIN/cad-voice" # e.g. wss://metsite-production.up.railway.app/cad-voice
# ─────────────────────────────────────────────────────────────────────────────

set -e
REPO="https://github.com/DecryptedGuest/metsite"
BRANCH="claude/group-roles-permissions-6yn2fq"
DIR="/opt/met/app/voice-worker"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates

# Node.js 20 (NodeSource) — skip if already present (idempotent across re-runs)
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

# Download the worker (or update it if this script runs again on a later boot)
mkdir -p /opt/met
if [ -d /opt/met/app/.git ]; then
  cd /opt/met/app
  git fetch --depth 1 origin "$BRANCH" && git reset --hard FETCH_HEAD
else
  git clone --branch "$BRANCH" --depth 1 "$REPO" /opt/met/app
fi
cd "$DIR"
npm install --omit=dev

# Environment (read by the systemd service below; not committed anywhere)
cat > "$DIR/.env" <<ENVEOF
VOICE_BOT_TOKEN=$VOICE_BOT_TOKEN
WORKER_SECRET=$WORKER_SECRET
ELEVENLABS_API_KEY=$ELEVENLABS_API_KEY
CAD_MAIN_WS_URL=$CAD_MAIN_WS_URL
ENVEOF
chmod 600 "$DIR/.env"

# Run it as a service: auto-restart on crash, auto-start on reboot
cat > /etc/systemd/system/met-voice.service <<UNITEOF
[Unit]
Description=MET CAD Voice Worker
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR
EnvironmentFile=$DIR/.env
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
UNITEOF

systemctl daemon-reload
systemctl enable met-voice
systemctl start met-voice

# Handy log marker
echo "MET voice worker installed. Check: systemctl status met-voice ; journalctl -u met-voice -f" > /root/met-voice-README.txt
