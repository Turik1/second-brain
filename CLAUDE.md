# Second Brain → Open Brain

Telegram bot that captures thoughts via Claude API metadata extraction, stores in Postgres+pgvector, and exposes via MCP server for cross-tool semantic search.

## Stack
- TypeScript, Express, grammY (Telegram), Anthropic SDK, Voyage AI, pg (Postgres+pgvector), MCP SDK
- Docker (node:22-slim), Caddy reverse proxy, Docker Compose
- Deployed to Hetzner VPS at /opt/second-brain

## Commands
- `npm run dev` - watch mode (long polling)
- `npm run build` - compile TypeScript
- `npm start` - run compiled app
- `npx -p typescript tsc --noEmit` - type-check

## Architecture
- `src/index.ts` - entry point: Express server + bot startup (webhook or long polling) + MCP endpoint
- `src/bot/` - grammY bot setup, command handlers, message handler
- `src/brain/` - thought capture pipeline (embed + extract + insert)
- `src/db/` - Postgres connection pool, migrations, query layer
- `src/embeddings/` - Voyage AI embedding generation
- `src/extractor/` - Claude Haiku metadata extraction
- `src/mcp/` - MCP server with 4 tools (search, list, stats, capture)
- `src/digest/` - daily/weekly digest, overview, afternoon reminder, cron scheduler
- `src/utils/` - logger (pino), state, errors
- `src/config.ts` - Zod-validated env config

## Data Model
Single `thoughts` table in Postgres with pgvector:
- content (text), embedding (vector 1024), title, thought_type, topics[], people[], action_items[]
- source tracking (source, source_id, chat_id)
- Semantic search via HNSW cosine similarity index

## MCP Tools
- `search_thoughts` - semantic search by meaning
- `list_recent` - browse recent captures
- `thought_stats` - usage patterns and top topics/people
- `capture_thought` - write thoughts from any MCP client

## Code Style
- ESM imports with .js extensions (TypeScript with NodeNext resolution)
- Barrel exports via index.ts in each module
- Zod for all validation (config, API responses, metadata extraction)
- All bot responses and digest prompts in German

## Deployment
- Push to main → GitHub Actions SSH → deploy.sh on VPS
- deploy.sh: git pull, docker compose up --build, health check, auto-rollback
- VPS user: `deploy`

## Scheduler
- Daily digest: DAILY_DIGEST_HOUR (default 8), DIGEST_TIMEZONE (default Europe/Berlin)
- Afternoon reminder: AFTERNOON_REMINDER_HOUR (default 14)
- Weekly digest: WEEKLY_DIGEST_DAY (default 0 = Sunday) at DAILY_DIGEST_HOUR

## Gotchas
- node:22-slim has no wget/curl — Docker healthcheck uses `node -e fetch(...)`
- Caddy DOMAIN env: set to `:80` for IP-only mode, set to domain for auto-TLS
- App uses long polling when WEBHOOK_DOMAIN is unset, webhook mode when set
- .env is on VPS only (gitignored) — see .env.example for required vars
- Repo is public — never commit secrets
- MCP endpoint at /mcp uses bearer token auth (MCP_ACCESS_KEY)
- Postgres runs as a Docker container alongside the app (pgvector/pgvector:pg16)
- Voyage AI API requires separate API key from voyageai.com
