#!/usr/bin/env bash
#
# Initial setup for a fresh Ubuntu VPS.
# Run as root: bash server-init.sh
#
set -euo pipefail

REPO_URL="https://github.com/Turik1/second-brain.git"
APP_DIR="/opt/second-brain"
DEPLOY_USER="deploy"

echo "==> [1/6] Updating system packages..."
apt-get update -qq && apt-get upgrade -y -qq

echo "==> [2/6] Installing Docker..."
if ! command -v docker &>/dev/null; then
  apt-get install -y -qq ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo \
    "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
    https://download.docker.com/linux/ubuntu \
    $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
else
  echo "    Docker already installed, skipping."
fi

echo "==> [3/6] Creating deploy user..."
if ! id "$DEPLOY_USER" &>/dev/null; then
  useradd -m -s /bin/bash -G docker "$DEPLOY_USER"
  mkdir -p /home/$DEPLOY_USER/.ssh
  cp /root/.ssh/authorized_keys /home/$DEPLOY_USER/.ssh/authorized_keys
  chown -R $DEPLOY_USER:$DEPLOY_USER /home/$DEPLOY_USER/.ssh
  chmod 700 /home/$DEPLOY_USER/.ssh
  chmod 600 /home/$DEPLOY_USER/.ssh/authorized_keys
  echo "    Created user '$DEPLOY_USER' with Docker access."
else
  echo "    User '$DEPLOY_USER' already exists, skipping."
fi

echo "==> [4/6] Cloning repository..."
if [ ! -d "$APP_DIR" ]; then
  git clone "$REPO_URL" "$APP_DIR"
  chown -R $DEPLOY_USER:$DEPLOY_USER "$APP_DIR"
else
  echo "    $APP_DIR already exists, skipping clone."
fi

echo "==> [5/6] Creating .env file..."
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  echo ""
  echo "    *** IMPORTANT: Edit $APP_DIR/.env with your real values ***"
  echo "    Run: nano $APP_DIR/.env"
  echo ""
else
  echo "    .env already exists, skipping."
fi

echo "==> [6/6] Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Edit the .env file:  nano $APP_DIR/.env"
echo "  2. Start the app:       cd $APP_DIR && docker compose up -d --build"
echo "  3. Check health:        curl http://localhost/health"
echo "  4. View logs:           cd $APP_DIR && docker compose logs -f"
echo ""
echo "  GitHub Actions secret VPS_USER should be set to: $DEPLOY_USER"
