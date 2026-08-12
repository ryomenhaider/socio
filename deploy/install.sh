#!/usr/bin/env bash
# Install socio on an Oracle Cloud free instance (Ubuntu 22.04/24.04).
#
# usage:  bash deploy/install.sh /home/ubuntu/socio
#
# Domain defaults to vektorlabs.xyz (override with a second arg). This sets up
# Node 22, npm dependencies, .env (BASE_URL=https://<domain>), nginx, a Let's
# Encrypt certificate via certbot, and a systemd service so socio runs forever.

set -euo pipefail

APP_DIR="${1:?usage: bash deploy/install.sh /home/ubuntu/socio [domain] [app-user]}"
DOMAIN="${2:-}"
APP_USER="${3:-ubuntu}"

if [[ "${DOMAIN}" == "vektorlabs.xyz" ]]; then
  echo "==> Using default domain: https://${DOMAIN}"
  echo "    (A record ${DOMAIN} must point to this instance, e.g. 141.148.15.111)"
fi

echo "==> Installing system packages (nodejs, nginx, certbot)"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
  sudo apt-get install -y nodejs
fi
node -v || { echo "node install failed"; exit 1; }
sudo apt-get update -y
sudo apt-get install -y nginx certbot python3-certbot-nginx

echo "==> Installing npm dependencies (production only)"
cd "${APP_DIR}"
npm ci --omit=dev

echo "==> Creating .env if missing"
if [[ ! -f "${APP_DIR}/.env" ]]; then
  cp "${APP_DIR}/.env.example" "${APP_DIR}/.env"
  echo "    Created ${APP_DIR}/.env - EDIT IT with your API credentials, then restart the service."
else
  echo "    .env already exists - leaving it alone."
fi
if ! grep -q '^SESSION_SECRET=.' "${APP_DIR}/.env"; then
  echo "SESSION_SECRET=$(openssl rand -hex 32)" >> "${APP_DIR}/.env"
  echo "    Generated a random SESSION_SECRET."
fi

if [[ -n "${DOMAIN}" ]]; then
  sed -i "s|^BASE_URL=.*|BASE_URL=https://${DOMAIN}|" "${APP_DIR}/.env" || true
fi

echo "==> Enabling socio as a systemd service"
sudo mkdir -p /opt/socio-deploy
sed -e "s|__APP_DIR__|${APP_DIR}|g" -e "s|__APP_USER__|${APP_USER}|g" \
  "${APP_DIR}/deploy/socio.service" | sudo tee /etc/systemd/system/socio.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now socio
echo "    waiting for socio to come up (up to 30s)..."
up=0
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:3000/healthz >/dev/null 2>&1; then
    up=1
    break
  fi
  if ! systemctl is-active --quiet socio; then
    break
  fi
  sleep 1
done
if [[ "${up}" != "1" ]]; then
  echo "    socio failed to start - check: journalctl -u socio -n 50"
  exit 1
fi
echo "    socio is UP on http://127.0.0.1:3000"

if [[ -n "${DOMAIN}" ]]; then
  echo "==> Configuring nginx + certbot for ${DOMAIN}"
  sed "s|__DOMAIN__|${DOMAIN}|g" "${APP_DIR}/deploy/nginx-socio.conf" | sudo tee /etc/nginx/sites-available/socio >/dev/null
  sudo ln -sf /etc/nginx/sites-available/socio /etc/nginx/sites-enabled/socio
  sudo nginx -t
  sudo systemctl reload nginx
  sudo certbot --nginx -d "${DOMAIN}" --redirect --non-interactive --agree-tos -m admin@"${DOMAIN}" || {
    echo "    certbot failed - run manually: sudo certbot --nginx -d ${DOMAIN}"
  }
fi

echo ""
echo "==> Done. Firewall checklist:"
echo "    1. OCI console: VCN -> Security List of your subnet -> add ingress rules for TCP 80 and 443"
if command -v iptables >/dev/null 2>&1; then
  echo "    2. Instance OS firewall (Oracle Ubuntu images use iptables):"
  echo "       sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT"
  echo "       sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT"
  echo "       sudo netfilter-persistent save"
fi
echo ""
echo "Useful commands:"
echo "  systemctl status socio          # service status"
echo "  journalctl -u socio -f          # live logs"
echo "  sudo certbot renew --dry-run    # verify auto-renewal"
echo "  curl https://${DOMAIN:-your-domain}/healthz   # health check"
