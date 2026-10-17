#!/usr/bin/env bash
# Crewbase one-command setup for a free Oracle Cloud (or any Ubuntu) server.
#   curl -fsSL https://raw.githubusercontent.com/youssefhani111/Crewbase/main/deploy/setup.sh | bash
# Safe to run again: it updates the code and restarts the app.
set -euo pipefail

REPO="${REPO:-https://github.com/youssefhani111/Crewbase.git}"
APP_DIR=/opt/crewbase
ME="$(id -un)"
say() { printf '\n\033[1;33m▸ %s\033[0m\n' "$*"; }
ask() { local v; read -r -p "$1" v </dev/tty; printf '%s' "$v"; }
ask_secret() { local v; read -r -s -p "$1" v </dev/tty; echo >&2; printf '%s' "$v"; }

say "Installing system packages"
sudo apt-get update -y
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git

if ! command -v docker >/dev/null; then
  say "Installing Docker"
  curl -fsSL https://get.docker.com | sudo sh
fi
sudo usermod -aG docker "$ME"

if ! node -v 2>/dev/null | grep -qE '^v(2[2-9]|[3-9][0-9])'; then
  say "Installing Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

say "Getting the Crewbase code"
sudo mkdir -p "$APP_DIR" && sudo chown "$ME" "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then git -C "$APP_DIR" pull --ff-only; else git clone "$REPO" "$APP_DIR"; fi
cd "$APP_DIR"
npm ci --omit=dev

say "Building the agents' computer image (takes a few minutes the first time)"
sudo docker build -t crewbase-agent:latest agent-image
sudo docker network inspect crewbase-agents >/dev/null 2>&1 || \
  sudo docker network create --driver bridge -o com.docker.network.bridge.name=cb-agents --subnet 172.30.0.0/16 crewbase-agents
sudo install -m 755 deploy/firewall.sh /usr/local/sbin/crewbase-firewall
sudo /usr/local/sbin/crewbase-firewall

PUBIP="$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me)"
DOMAIN="${DOMAIN:-${PUBIP//./-}.sslip.io}"

if [ ! -f .env ]; then
  say "Settings"
  echo "Get a free Gemini API key at https://aistudio.google.com/apikey"
  GEMINI_KEY="$(ask_secret 'Paste your Gemini API key (hidden): ')"
  ADMIN="$(ask 'Your email (becomes admin): ')"
  INVITE="$(ask 'Invite code for sign-ups (leave empty to let anyone join): ')"
  cat > .env <<EOF
APP_NAME=Crewbase
NODE_ENV=production
PORT=3000
DATA_DIR=$APP_DIR/data
PUBLIC_URL=https://$DOMAIN
ADMIN_EMAILS=$ADMIN
INVITE_CODE=$INVITE
LLM_PROVIDER=openai
GEMINI_API_KEY=$GEMINI_KEY
OPENAI_COMPAT_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
ALLOWED_MODELS=gemini-3.8-flash
SANDBOX_PROVIDER=docker
MAX_RUNS_PER_USER_PER_DAY=15
MAX_AGENTS_PER_USER=3
MAX_CONCURRENT_RUNS=3
DOCKER_AGENT_CPUS=0.5
DOCKER_AGENT_MEMORY=768m
EOF
  chmod 600 .env
fi

say "Starting Crewbase as a service"
sudo tee /etc/systemd/system/crewbase.service >/dev/null <<EOF
[Unit]
Description=Crewbase
After=network-online.target docker.service
Requires=docker.service

[Service]
User=$ME
WorkingDirectory=$APP_DIR
ExecStartPre=+/usr/local/sbin/crewbase-firewall
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning server/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now crewbase
sudo systemctl restart crewbase

say "Turning on HTTPS for https://$DOMAIN"
sudo docker rm -f crewbase-caddy >/dev/null 2>&1 || true
sudo docker run -d --name crewbase-caddy --restart unless-stopped --network host \
  -v crewbase-caddy:/data caddy:2 caddy reverse-proxy --from "$DOMAIN" --to localhost:3000 >/dev/null

sleep 3
if curl -fsS localhost:3000/api/config >/dev/null; then
  say "Done! Open https://$DOMAIN and sign up with your admin email."
  echo "  (If it doesn't open, allow ports 80 and 443 in Oracle: Networking → your VCN → Security List → Add Ingress Rules.)"
else
  say "The app didn't start. Show the error with:  sudo journalctl -u crewbase -n 50"
fi
