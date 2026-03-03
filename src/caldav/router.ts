import express from 'express';
import { CalDavCache } from './cache.js';
import { createHandlers } from './handlers.js';
import { queryAllAdmin } from '../notion/index.js';
import { logger } from '../utils/logger.js';

export function createCaldavRouter(): { router: express.Router; cache: CalDavCache } {
  const router = express.Router();
  const cache = new CalDavCache(() => queryAllAdmin(100));
  const handlers = createHandlers(cache);

  // Parse text bodies for CalDAV (XML + iCalendar)
  router.use(express.text({ type: ['application/xml', 'text/xml', 'text/calendar', 'application/octet-stream'] }));

  // Import auth lazily to avoid config validation at import time in tests
  let authMiddleware: express.RequestHandler | null = null;

  async function ensureAuth(): Promise<express.RequestHandler> {
    if (!authMiddleware) {
      const { caldavAuth } = await import('./auth.js');
      authMiddleware = caldavAuth;
    }
    return authMiddleware;
  }

  // Route all requests by HTTP method
  router.all('*', async (req, res) => {
    try {
      // Apply auth
      const auth = await ensureAuth();
      await new Promise<void>((resolve, reject) => {
        auth(req, res, (err?: unknown) => {
          if (err) reject(err);
          else resolve();
        });
      });

      // If auth middleware sent a response (401), stop
      if (res.headersSent) return;

      switch (req.method) {
        case 'PROPFIND':
          return await handlers.handlePropfind(req, res);
        case 'REPORT':
          return await handlers.handleReport(req, res);
        case 'GET':
          return await handlers.handleGet(req, res);
        case 'PUT':
          return await handlers.handlePut(req, res);
        case 'DELETE':
          return await handlers.handleDelete(req, res);
        case 'OPTIONS':
          return handlers.handleOptions(req, res);
        default:
          res.status(405).set('Allow', 'OPTIONS, GET, PUT, DELETE, PROPFIND, REPORT').send();
      }
    } catch (err) {
      logger.error({ event: 'caldav_error', method: req.method, path: req.path, error: err });
      if (!res.headersSent) {
        res.status(500).send('Internal Server Error');
      }
    }
  });

  // Initial cache load (non-blocking)
  void cache.refresh();

  logger.info({ event: 'caldav_router_created' }, 'CalDAV router initialized');
  return { router, cache };
}
