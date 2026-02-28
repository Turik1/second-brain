# Second Brain

Telegram bot that classifies messages via Claude API and saves to Notion databases.

## Stack
- TypeScript, Express, grammY (Telegram), Anthropic SDK, Notion API
- Docker (node:22-slim), Caddy reverse proxy, Docker Compose
- Deployed to Hetzner VPS at /opt/second-brain

## Commands
- `npm run dev` - watch mode (long polling)
- `npm run build` - compile TypeScript
- `npm start` - run compiled app
- `npm run setup` - initialize Notion databases

## Deployment
- Push to main → GitHub Actions SSH → deploy.sh on VPS
- deploy.sh: git pull, docker compose up --build, health check, auto-rollback
- VPS user: `deploy` (has Docker group access, no sudo password)
- SSH access details in .claude.local.md

## Architecture
- `src/index.ts` - entry point: Express server + bot startup (webhook or long polling)
- `src/bot/` - grammY bot setup, command handlers, message handler, intent detection
- `src/classifier/` - Claude API classification with Zod schemas
- `src/digest/` - daily/weekly digest generation, cron scheduler, overview
- `src/notion/` - Notion API wrapper and database operations
- `src/utils/` - logger (pino), state, errors, retry, telegram helpers
- `src/config.ts` - Zod-validated env config

## Code Style
- ESM imports with .js extensions (TypeScript with NodeNext resolution)
- Barrel exports via index.ts in each module
- Zod for all validation (config, API responses, classification output)

## Gotchas
- node:22-slim has no wget/curl — Docker healthcheck uses `node -e fetch(...)`
- Caddy DOMAIN env: set to `:80` for IP-only mode, set to domain for auto-TLS
- docker-compose.yml defaults DOMAIN to `:80` — Caddyfile fallback `{$DOMAIN::80}` only works if DOMAIN is unset
- App uses long polling when WEBHOOK_DOMAIN is unset, webhook mode when set
- .env is on VPS only (gitignored) — see .env.example for required vars
- Repo is public — never commit secrets
