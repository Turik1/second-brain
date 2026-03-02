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
- `src/digest/` - daily/weekly digest, overview, afternoon reminder, interactive weekly review, cron scheduler
- `src/bot/handlers/review.ts` - callback handlers for weekly review + idea curation buttons
- `src/notion/` - Notion API wrapper and database operations
- `src/utils/` - logger (pino), state, errors, retry, telegram helpers
- `src/config.ts` - Zod-validated env config

## Code Style
- ESM imports with .js extensions (TypeScript with NodeNext resolution)
- Barrel exports via index.ts in each module
- Zod for all validation (config, API responses, classification output)

## Notion DB Properties
- Admin: Name, Type, Status (pending/done/cancelled), Priority (high/medium/low), Due Date, Tags
- Projects: Name, Status, Description, Priority, Next Action, Tags
- Ideas: Name, Category, Description, Potential (high/medium/low/unknown), Tags
- People: Name, Relationship, Context, Tags
- All 4 DBs have cross-category Relation properties (Related People/Projects/Ideas/Admin)

## Scheduler
- Daily digest: DAILY_DIGEST_HOUR (default 8), DIGEST_TIMEZONE (default Europe/Berlin)
- Afternoon reminder: AFTERNOON_REMINDER_HOUR (default 14) — only sends if tasks due/overdue
- Weekly digest: WEEKLY_DIGEST_DAY (default 0 = Sunday) at DAILY_DIGEST_HOUR
- Weekly review: 30 min after weekly digest — interactive buttons, WEEKLY_REVIEW_ENABLED (default true)

## Gotchas
- node:22-slim has no wget/curl — Docker healthcheck uses `node -e fetch(...)`
- Caddy DOMAIN env: set to `:80` for IP-only mode, set to domain for auto-TLS
- docker-compose.yml defaults DOMAIN to `:80` — Caddyfile fallback `{$DOMAIN::80}` only works if DOMAIN is unset
- App uses long polling when WEBHOOK_DOMAIN is unset, webhook mode when set
- .env is on VPS only (gitignored) — see .env.example for required vars
- Repo is public — never commit secrets
- Telegram callback_data has 64-byte limit — use in-memory maps with numeric keys for long IDs (see bouncer, intent, relation patterns in message.ts)
- node_modules not installed locally — use `npx -p typescript tsc --noEmit` for type-checking
- Notion API `pages.update` with relation property REPLACES all relations — must read-then-append
