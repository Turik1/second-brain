import 'dotenv/config';
import http from 'http';
import express from 'express';
import { webhookCallback, InlineKeyboard } from 'grammy';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { getHealthState, setNotionConnected } from './utils/state.js';
import { createBot } from './bot/index.js';
import { initializeScheduler, generateDailyDigest, generateWeeklyDigest, generateOverview } from './digest/index.js';
import { runMigrations, closePool } from './db/index.js';
import { createMcpServer, mcpAuth } from './mcp/index.js';

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, 'Second Brain starting');

  await runMigrations();

  // Handle unhandled rejections without crashing
  process.on('unhandledRejection', (reason) => {
    logger.error({ event: 'unhandled_rejection', reason }, 'Unhandled promise rejection');
  });

  process.on('uncaughtException', (err) => {
    logger.error({ event: 'uncaught_exception', error: err }, 'Uncaught exception');
  });

  const bot = createBot();

  // Helper: send a message to the allowed chat
  const sendToUser = async (text: string): Promise<void> => {
    await bot.api.sendMessage(config.ALLOWED_CHAT_ID, text, { parse_mode: 'HTML' });
  };

  // Helper: send a message with optional inline keyboard
  const sendWithKeyboard = async (text: string, keyboard?: InlineKeyboard): Promise<void> => {
    await bot.api.sendMessage(config.ALLOWED_CHAT_ID, text, {
      parse_mode: 'HTML',
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  };

  // Register on-demand digest commands
  bot.command('digest', async (ctx) => {
    logger.info({ messageId: ctx.message?.message_id }, 'Command: /digest');
    await ctx.reply('Generating daily digest...');
    try {
      await generateDailyDigest(sendToUser);
    } catch (err) {
      logger.error({ error: err }, 'Manual daily digest failed');
      await ctx.reply('Failed to generate digest. Check logs for details.');
    }
  });

  bot.command('weekly', async (ctx) => {
    logger.info({ messageId: ctx.message?.message_id }, 'Command: /weekly');
    await ctx.reply('Generating weekly digest...');
    try {
      await generateWeeklyDigest(sendToUser);
    } catch (err) {
      logger.error({ error: err }, 'Manual weekly digest failed');
      await ctx.reply('Failed to generate weekly digest. Check logs for details.');
    }
  });

  bot.command('overview', async (ctx) => {
    logger.info({ messageId: ctx.message?.message_id }, 'Command: /overview');
    await ctx.reply('Generating overview, this may take a moment...');
    try {
      await generateOverview(sendToUser);
    } catch (err) {
      logger.error({ error: err }, 'Overview generation failed');
      await ctx.reply('Failed to generate overview. Check logs for details.');
    }
  });

  const app = express();
  app.use(express.json());

  // Enriched health check endpoint
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      ...getHealthState(),
    });
  });

  // ─── MCP server for AI client access ──────────────────────────────────────

  app.post('/mcp', mcpAuth, async (req, res) => {
    const server = createMcpServer();
    try {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      res.on('close', () => {
        transport.close();
        server.close();
      });
    } catch (err) {
      logger.error({ error: err }, 'MCP request failed');
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  app.get('/mcp', mcpAuth, async (_req, res) => {
    res.writeHead(405).end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed. Use POST.' },
      id: null,
    }));
  });

  app.delete('/mcp', mcpAuth, async (_req, res) => {
    res.writeHead(405).end(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    }));
  });

  const isWebhookMode =
    config.NODE_ENV === 'production' && config.WEBHOOK_DOMAIN !== undefined;

  const scheduler = initializeScheduler(sendToUser, sendWithKeyboard, bot);

  let server: http.Server;

  if (isWebhookMode) {
    // Webhook mode for production
    const webhookPath = `/${config.TELEGRAM_BOT_TOKEN}`;
    app.post(webhookPath, webhookCallback(bot, 'express'));

    server = app.listen(config.PORT, async () => {
      logger.info({ port: config.PORT }, 'Express server listening');
      const webhookUrl = `${config.WEBHOOK_DOMAIN}${webhookPath}`;
      await bot.api.setWebhook(webhookUrl);
      logger.info({ webhookUrl }, 'Webhook set');
      setNotionConnected(true);
    });
  } else {
    // Long polling for development
    server = app.listen(config.PORT, () => {
      logger.info({ port: config.PORT }, 'Express server listening (dev mode)');
      setNotionConnected(true);
    });

    await bot.start({
      onStart: (info) => logger.info({ username: info.username }, 'Bot started polling'),
    });
  }

  // ─── Graceful shutdown ────────────────────────────────────────────────────

  const SHUTDOWN_TIMEOUT_MS = 30_000;

  async function shutdown(signal: string): Promise<void> {
    logger.info({ signal }, 'Shutdown signal received');

    // Stop accepting new requests
    server.close(() => {
      logger.info('HTTP server closed');
    });

    // Stop cron jobs
    scheduler.stop();

    // Wait for in-flight messages to complete (max 30s)
    const deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
    while (getHealthState().pendingMessages > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const { pendingMessages } = getHealthState();
    if (pendingMessages > 0) {
      logger.warn({ pendingMessages }, 'Shutdown timeout: some messages still in flight');
    }

    // Stop the bot
    try {
      await bot.stop();
    } catch {
      // ignore errors during shutdown
    }

    await closePool();
    logger.info('Shutdown complete');
    process.exit(0);
  }

  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ error: err }, 'Fatal startup error');
  process.exit(1);
});
