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
- `npm test` - run tests (vitest)
- `npx tsc --noEmit` - type-check only

## Architecture
- `src/index.ts` - entry point: Express server + bot startup (webhook or long polling) + MCP endpoint
- `src/bot/` - grammY bot setup, command handlers (/done, /delete, /open, digests), message handler
- `src/brain/` - thought capture pipeline (embed + extract + insert)
- `src/db/` - Postgres connection pool, migrations, query layer
- `src/embeddings/` - Voyage AI embedding generation
- `src/extractor/` - Claude Haiku metadata extraction
- `src/mcp/` - MCP server with 7 tools (search, list, stats, capture, open tasks, complete, delete)
- `src/digest/` - daily/weekly digest, overview, afternoon reminder, cron scheduler
- `src/utils/` - logger (pino), state, telegram helpers
- `src/config.ts` - Zod-validated env config

## Data Model
Single `thoughts` table in Postgres with pgvector:
- content (text), embedding (vector 1024), title, thought_type, topics[], people[], action_items[]
- status (open/done/cancelled), due_date, priority (high/medium/low)
- source tracking (source, source_id, chat_id)
- Semantic search via HNSW cosine similarity index
- Dedup: ON CONFLICT (source, source_id) DO NOTHING
- Migrations auto-run on startup (src/db/migrate.ts)

## MCP Tools
- `search_thoughts` - semantic search by meaning (optional status filter)
- `list_recent` - browse recent captures (optional status filter)
- `thought_stats` - usage patterns and top topics/people
- `capture_thought` - write thoughts from any MCP client
- `list_open_tasks` - open tasks sorted by due date
- `complete_thought` - mark task done by ID
- `delete_thought` - soft-delete by ID

## Bot Commands
- `/open` - list open tasks with due dates and priority
- `/done` (reply) - mark a thought as completed
- `/delete` (reply) - soft-delete a thought
- `/digest`, `/weekly`, `/overview` - generate digests on demand

## Code Style
- ESM imports with .js extensions (TypeScript with NodeNext resolution)
- Barrel exports via index.ts in each module
- Zod for all validation (config, API responses, metadata extraction)
- All bot responses and digest prompts in German
- Claude Haiku 4.5 for metadata extraction, Claude Sonnet 4.5 for digests/overview

## Environment
Required: `TELEGRAM_BOT_TOKEN`, `ALLOWED_CHAT_ID`, `ANTHROPIC_API_KEY`, `DATABASE_URL`, `VOYAGE_API_KEY`, `MCP_ACCESS_KEY`
Optional: `WEBHOOK_DOMAIN`, `PORT` (3000), `NODE_ENV`, `DIGEST_TIMEZONE` (Europe/Berlin), `DAILY_DIGEST_HOUR` (8), `WEEKLY_DIGEST_DAY` (0), `AFTERNOON_REMINDER_HOUR` (14)

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
- grammY: handler registration order matters — commands must be registered BEFORE `bot.on('message')` or they'll be silently swallowed
- MCP stateless mode: must create new McpServer + StreamableHTTPServerTransport per request (server.connect takes ownership)
- vitest: `dist/` must be excluded in vitest.config.ts or tests run twice (compiled JS copies)
