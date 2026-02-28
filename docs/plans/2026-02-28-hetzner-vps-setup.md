# Hetzner VPS Initial Setup — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create an automated server init script and update Caddyfile so the app can deploy to a fresh Ubuntu Hetzner VPS without a domain name.

**Architecture:** A single `scripts/server-init.sh` runs on the VPS as root. It installs Docker, creates a `deploy` user, clones the repo, and starts the stack. The Caddyfile is updated to support IP-only mode (`:80` fallback). The bot runs in long-polling mode until a domain is configured.

**Tech Stack:** Bash, Docker, Docker Compose, Caddy, Git, SSH

---

### Task 1: Update Caddyfile for IP-only mode

**Files:**
- Modify: `Caddyfile`

**Step 1: Update the Caddyfile**

Replace the current domain-only config with one that supports both modes:

```caddyfile
{$DOMAIN::80} {
    reverse_proxy app:3000
}
```

This uses Caddy's default placeholder syntax: if `DOMAIN` env var is set, Caddy serves on that domain with auto-TLS. If unset, it defaults to `:80` (plain HTTP on all interfaces).

**Step 2: Verify locally (optional)**

```bash
DOMAIN=":80" docker compose up caddy --no-start
docker compose config | grep DOMAIN
```

**Step 3: Commit**

```bash
git add Caddyfile
git commit -m "feat: support IP-only mode in Caddyfile with :80 fallback"
```

---

### Task 2: Create the server init script

**Files:**
- Create: `scripts/server-init.sh`

**Step 1: Write the script**

```bash
#!/usr/bin/env bash
#
# Initial setup for a fresh Ubuntu VPS.
# Run as root: bash scripts/server-init.sh
#
set -euo pipefail

REPO_URL="https://github.com/<OWNER>/second-brain.git"
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
  # Copy root's authorized_keys so GitHub Actions can SSH as deploy
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
```

**NOTE:** The `<OWNER>` placeholder in `REPO_URL` must be replaced with the actual GitHub username/org.

**Step 2: Make executable**

```bash
chmod +x scripts/server-init.sh
```

**Step 3: Commit**

```bash
git add scripts/server-init.sh
git commit -m "feat: add server-init.sh for initial VPS provisioning"
```

---

### Task 3: Update deploy.sh for IP-only health check

**Files:**
- Modify: `deploy.sh`

**Step 1: Update the health check fallback**

The current `deploy.sh` extracts the domain from `.env` and curls `https://$DOMAIN/health`. Without a domain, this fails. Update to fall back to `localhost`:

Replace the health check section (lines 20-30):

```bash
DOMAIN=$(grep -oP 'WEBHOOK_DOMAIN=https?://\K[^/]+' .env || echo "")

if [ -n "$DOMAIN" ]; then
  HEALTH_URL="https://${DOMAIN}/health"
else
  HEALTH_URL="http://localhost/health"
fi

if curl -sf "$HEALTH_URL" > /dev/null 2>&1; then
  echo "==> Deploy successful! App is healthy."
else
  echo "==> Health check failed. Rolling back to ${PREV_SHA}..."
  git checkout "$PREV_SHA"
  docker compose up -d --build
  echo "==> Rolled back. Check logs: docker compose logs app"
  exit 1
fi
```

**Step 2: Commit**

```bash
git add deploy.sh
git commit -m "fix: deploy.sh health check works without domain"
```

---

### Task 4: Push and run on VPS

This task is manual — the user does it.

**Step 1: Push all commits**

```bash
git push origin main
```

**Step 2: SSH into VPS and run the init script**

```bash
# From local machine
scp scripts/server-init.sh root@<VPS_IP>:/tmp/server-init.sh
ssh root@<VPS_IP> "bash /tmp/server-init.sh"
```

**Step 3: Fill in .env on the VPS**

```bash
ssh root@<VPS_IP> "nano /opt/second-brain/.env"
```

**Step 4: Start the stack**

```bash
ssh root@<VPS_IP> "cd /opt/second-brain && docker compose up -d --build"
```

**Step 5: Verify**

```bash
ssh root@<VPS_IP> "curl -s http://localhost/health | python3 -m json.tool"
```

**Step 6: Update GitHub secret**

Change `VPS_USER` from `root` to `deploy` in GitHub repo settings.

**Step 7: Test the CI/CD pipeline**

Make a trivial commit and push to trigger GitHub Actions. Verify the workflow succeeds.
