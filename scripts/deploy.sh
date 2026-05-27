#!/bin/bash
# ═════════════════════════════════════════════════════════════════════════════
# ask.iamhmn.org — deployment script (idempotent)
#
# Run on the production server as root:
#   bash deploy.sh
#
# What this does:
#   1. Creates PostgreSQL DB `askhuman` + user `askhuman` if not present
#   2. Applies schema (CREATE TABLE IF NOT EXISTS — safe to re-run)
#   3. Installs nginx vhost for ask.iamhmn.org
#   4. Runs certbot for HTTPS (if not yet present)
#   5. Installs Node deps, generates .env if missing
#   6. Starts under PM2 as `askhuman`
#
# Prerequisites (must already exist):
#   - Node 20+, PostgreSQL 16+, nginx, certbot, PM2
#   - DNS A-record for ask.iamhmn.org → server IP
# ═════════════════════════════════════════════════════════════════════════════

set -e

APP_NAME="askhuman"
DOMAIN="ask.iamhmn.org"
APP_DIR="/var/www/${APP_NAME}"
APP_USER="www-data"
APP_PORT="3001"
NGINX_CONF="/etc/nginx/sites-available/${APP_NAME}.conf"

# ─── 1. Sanity checks ─────────────────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
  echo "Run as root (sudo bash deploy.sh)"
  exit 1
fi

command -v node      >/dev/null || { echo "Node.js not installed"; exit 1; }
command -v psql      >/dev/null || { echo "PostgreSQL not installed"; exit 1; }
command -v nginx     >/dev/null || { echo "nginx not installed"; exit 1; }
command -v pm2       >/dev/null || { echo "PM2 not installed"; exit 1; }

echo "═══════════════════════════════════════════════════"
echo "  ask.iamhmn.org deployment"
echo "═══════════════════════════════════════════════════"

# ─── 2. Database ──────────────────────────────────────────────────────────────
echo ""
echo "→ Step 1: PostgreSQL database + user"

DB_PASS=$(sudo -u postgres psql -tAc "SELECT 'present' FROM pg_roles WHERE rolname = 'askhuman'")
if [ "$DB_PASS" != "present" ]; then
  GENERATED_PASS=$(openssl rand -hex 24)
  sudo -u postgres psql <<SQL
CREATE USER askhuman WITH PASSWORD '${GENERATED_PASS}';
CREATE DATABASE askhuman OWNER askhuman;
GRANT ALL PRIVILEGES ON DATABASE askhuman TO askhuman;
SQL
  echo "  ✓ Created DB + user (password saved to .env)"
  DB_PASSWORD_FOR_ENV="${GENERATED_PASS}"
else
  echo "  ✓ DB user already exists (skipping password reset)"
  DB_PASSWORD_FOR_ENV=""
fi

# Apply schema
echo "  → Applying schema..."
sudo -u postgres psql -d askhuman -f "$(dirname "$0")/../sql/schema.sql"
echo "  ✓ Schema applied"

# ─── 3. App files ─────────────────────────────────────────────────────────────
echo ""
echo "→ Step 2: App files"

mkdir -p "${APP_DIR}"
rsync -a --exclude=node_modules --exclude=.env "$(dirname "$0")/../" "${APP_DIR}/"
chown -R "${APP_USER}:${APP_USER}" "${APP_DIR}"
echo "  ✓ Files synced to ${APP_DIR}"

# ─── 4. .env file ─────────────────────────────────────────────────────────────
echo ""
echo "→ Step 3: Environment configuration"

if [ ! -f "${APP_DIR}/.env" ]; then
  SESSION_SECRET=$(openssl rand -hex 32)
  cat > "${APP_DIR}/.env" <<ENV
PORT=${APP_PORT}
BASE_URL=https://${DOMAIN}
NODE_ENV=production
HHTTPS_BASE=https://hhttps.org
HHTTPS_CLIENT_ID=ask-iamhmn
HHTTPS_CLIENT_SECRET=
SESSION_SECRET=${SESSION_SECRET}
DB_HOST=localhost
DB_PORT=5432
DB_NAME=askhuman
DB_USER=askhuman
DB_PASSWORD=${DB_PASSWORD_FOR_ENV}
ENV
  chmod 600 "${APP_DIR}/.env"
  chown "${APP_USER}:${APP_USER}" "${APP_DIR}/.env"
  echo "  ✓ Created .env"
  echo ""
  echo "  ⚠ IMPORTANT: If DB_PASSWORD is empty, edit ${APP_DIR}/.env manually"
  echo "    and set it to the password used when DB user was first created."
else
  echo "  ✓ .env already exists (preserving)"
fi

# ─── 5. Node dependencies ─────────────────────────────────────────────────────
echo ""
echo "→ Step 4: Node dependencies"

# www-data has no $HOME by default, which trips up npm trying to create
# /var/www/.npm. We pre-create it with correct ownership and pass HOME
# explicitly so npm puts its cache + logs there.
mkdir -p /var/www/.npm
chown -R "${APP_USER}:${APP_USER}" /var/www/.npm

cd "${APP_DIR}"
sudo -u "${APP_USER}" -H HOME=/var/www npm install --omit=dev --no-audit --no-fund --cache=/var/www/.npm
echo "  ✓ npm install complete"

# ─── 6. nginx vhost ───────────────────────────────────────────────────────────
echo ""
echo "→ Step 5: nginx vhost"

if [ -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
  # Cert exists → write full HTTPS config
  SSL_CONFIG_MODE="https"
else
  # No cert yet → write HTTP-only config first so nginx can start
  # and certbot can solve the challenge
  SSL_CONFIG_MODE="http-only"
fi

if [ ! -f "${NGINX_CONF}" ] || [ "$1" = "--reconfigure-nginx" ]; then
  if [ "$SSL_CONFIG_MODE" = "http-only" ]; then
    echo "  → Writing HTTP-only nginx config (cert will be installed next)..."
    cat > "${NGINX_CONF}" <<NGINX
# ask.iamhmn.org — HTTP-only stub (HTTPS comes after certbot)
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }
    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX
  else
    echo "  → Writing full HTTPS nginx config..."
    cat > "${NGINX_CONF}" <<NGINX
# ask.iamhmn.org — Q&A platform on top of HHTTPS OAuth
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root /var/www/html;
    }
    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${DOMAIN};

    ssl_certificate     /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;

    # Security headers
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;

    # Rate limit
    limit_req zone=askhuman_limit burst=20 nodelay;

    client_max_body_size 256K;

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade           \$http_upgrade;
        proxy_set_header Connection        "upgrade";
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_connect_timeout              30s;
        proxy_send_timeout                 30s;
        proxy_read_timeout                 30s;
    }
}
NGINX
  fi

  # Add rate-limit zone to nginx.conf if not present
  if ! grep -q "limit_req_zone.*askhuman_limit" /etc/nginx/nginx.conf; then
    sed -i '/http {/a\    limit_req_zone $binary_remote_addr zone=askhuman_limit:10m rate=10r/s;' /etc/nginx/nginx.conf
  fi

  ln -sf "${NGINX_CONF}" "/etc/nginx/sites-enabled/${APP_NAME}.conf"
  echo "  ✓ nginx vhost installed (mode: ${SSL_CONFIG_MODE})"
else
  echo "  ✓ nginx vhost already exists (preserving)"
fi

if ! nginx -t 2>&1; then
  echo "  ✗ nginx config test failed. Inspect /etc/nginx/sites-available/${APP_NAME}.conf"
  exit 1
fi
systemctl reload nginx
echo "  ✓ nginx reloaded"

# ─── 7. SSL via certbot ───────────────────────────────────────────────────────
echo ""
echo "→ Step 6: SSL certificate"

if [ ! -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
  echo "  → Requesting cert from Let's Encrypt..."

  # Pre-flight: verify DNS resolves to this server, otherwise certbot fails opaque
  RESOLVED_IP=$(dig +short "${DOMAIN}" | head -1)
  if [ -z "$RESOLVED_IP" ]; then
    echo "  ✗ DNS for ${DOMAIN} does not resolve. Set A-record first."
    echo "    Skipping SSL — re-run deploy.sh after DNS propagates."
    exit 1
  fi

  # webroot mode (works because we have HTTP-only nginx serving the challenge)
  mkdir -p /var/www/html
  certbot certonly --webroot -w /var/www/html -d "${DOMAIN}" \
          --non-interactive --agree-tos --email admin@iamhmn.org

  if [ ! -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ]; then
    echo "  ✗ certbot failed. Check /var/log/letsencrypt/letsencrypt.log"
    exit 1
  fi
  echo "  ✓ SSL cert obtained"

  # Now switch nginx to HTTPS mode
  echo "  → Switching nginx to HTTPS mode..."
  exec "$0" --reconfigure-nginx "$@"
else
  echo "  ✓ SSL cert already present"
fi

# ─── 8. PM2 ───────────────────────────────────────────────────────────────────
echo ""
echo "→ Step 7: PM2 process"

# Same issue as npm: PM2 needs a writable home dir. We've already chowned
# /var/www so /var/www/.pm2 will work.
mkdir -p /var/www/.pm2
chown -R "${APP_USER}:${APP_USER}" /var/www/.pm2

cd "${APP_DIR}"
# Check if process already running (under root's PM2 or www-data's PM2)
if sudo -u "${APP_USER}" -H HOME=/var/www PM2_HOME=/var/www/.pm2 pm2 list 2>/dev/null | grep -q "${APP_NAME}"; then
  sudo -u "${APP_USER}" -H HOME=/var/www PM2_HOME=/var/www/.pm2 pm2 reload "${APP_NAME}" --update-env
  echo "  ✓ PM2 process reloaded"
else
  sudo -u "${APP_USER}" -H HOME=/var/www PM2_HOME=/var/www/.pm2 \
       pm2 start server.js --name "${APP_NAME}" --time
  sudo -u "${APP_USER}" -H HOME=/var/www PM2_HOME=/var/www/.pm2 pm2 save
  echo "  ✓ PM2 process started"
fi

# Install systemd hook so PM2 starts on reboot (once-off)
if ! systemctl is-enabled "pm2-${APP_USER}" >/dev/null 2>&1; then
  echo "  → Setting up PM2 systemd startup..."
  env PATH="$PATH" pm2 startup systemd -u "${APP_USER}" --hp /var/www >/dev/null
  echo "  ✓ PM2 will auto-start on reboot"
fi

# ─── 9. OAuth client registration reminder ───────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════"
echo "  ✓ Deployment complete: https://${DOMAIN}"
echo "═══════════════════════════════════════════════════"
echo ""
echo "NEXT STEP — Register OAuth client in HHTTPS database:"
echo ""
echo "  sudo -u postgres psql -d hhttps -f register-oauth-client.sql"
echo ""
echo "After that, visit https://${DOMAIN} and click 'Mit HHTTPS einloggen'."
echo ""
