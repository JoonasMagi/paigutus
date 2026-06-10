#!/usr/bin/env bash
set -euo pipefail

# VPS setup script for the paigutus project
# Usage: sudo bash setup_vps.sh [git_repo_url] [app_dir] [deploy_user] [port]
# Example: sudo bash setup_vps.sh https://github.com/JoonasMagi/paigutus.git /opt/paigutus deploy 3000

REPO_URL="${1:-https://github.com/JoonasMagi/paigutus.git}"
APP_DIR="${2:-/opt/paigutus}"
DEPLOY_USER="${3:-deploy}"
PORT="${4:-3000}"
NODE_SETUP="18.x"

if [[ $(id -u) -ne 0 ]]; then
  echo "This script must be run as root (sudo)." >&2
  exit 1
fi

echo "==> Updating apt and installing prerequisites"
apt-get update -y
apt-get install -y curl git build-essential ufw ca-certificates

echo "==> Installing Node.js ${NODE_SETUP}"
curl -fsSL https://deb.nodesource.com/setup_${NODE_SETUP} | bash -
apt-get install -y nodejs

echo "==> Creating deploy user: ${DEPLOY_USER} (if missing)"
if ! id -u "${DEPLOY_USER}" >/dev/null 2>&1; then
  adduser --system --group --home "${APP_DIR}" --shell /bin/bash "${DEPLOY_USER}"
fi

echo "==> Cloning repository into ${APP_DIR} (or pulling latest)"
if [[ -d "${APP_DIR}/.git" ]]; then
  git -C "${APP_DIR}" fetch --all
  git -C "${APP_DIR}" reset --hard origin/main || true
else
  rm -rf "${APP_DIR}"
  git clone "${REPO_URL}" "${APP_DIR}"
fi

chown -R ${DEPLOY_USER}:${DEPLOY_USER} "${APP_DIR}"

echo "==> Installing npm dependencies"
cd "${APP_DIR}"
sudo -u ${DEPLOY_USER} npm install --production

echo "==> Creating environment file /etc/default/paigutus"
cat > /etc/default/paigutus <<EOF
# Environment file for systemd service
PORT=${PORT}
NODE_ENV=production
EOF

echo "==> Creating systemd service: /etc/systemd/system/paigutus.service"
cat > /etc/systemd/system/paigutus.service <<'SERVICE'
[Unit]
Description=Paigutus Node App
After=network.target

[Service]
Type=simple
User=__DEPLOY_USER__
WorkingDirectory=__APP_DIR__
EnvironmentFile=-/etc/default/paigutus
ExecStart=/usr/bin/node server.mjs
Restart=on-failure
RestartSec=5
KillMode=process

[Install]
WantedBy=multi-user.target
SERVICE

# Replace placeholders
sed -i "s|__DEPLOY_USER__|${DEPLOY_USER}|g" /etc/systemd/system/paigutus.service
sed -i "s|__APP_DIR__|${APP_DIR}|g" /etc/systemd/system/paigutus.service

echo "==> Reloading systemd and enabling service"
systemctl daemon-reload
systemctl enable paigutus.service
systemctl restart paigutus.service || true

echo "==> Configuring UFW: allow OpenSSH and port ${PORT}"
ufw allow OpenSSH
ufw allow ${PORT}/tcp
ufw --force enable || true

echo "==> Done. Application should be running. Check status with:"
echo "  sudo systemctl status paigutus.service"
echo "Logs: sudo journalctl -u paigutus.service -f"

exit 0
