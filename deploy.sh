#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

PREV_SHA=$(git rev-parse HEAD)

echo "==> Pulling latest code..."
git pull origin main

echo "==> Rebuilding and restarting containers..."
docker compose up -d --build

echo "==> Cleaning up old images..."
docker image prune -f

echo "==> Waiting for health check..."
sleep 5

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
