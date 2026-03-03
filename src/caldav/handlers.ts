import type { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import {
  updateAdminFromCalendar,
  updatePageStatus,
  createAdminPage,
} from '../notion/index.js';
import type { CalDavCache } from './cache.js';
import { pageToVEvent, wrapCalendar, parseVEvent } from './ical.js';
import {
  buildPrincipalPropfind,
  buildCalendarHomePropfind,
  buildCalendarPropfind,
  buildCalendarChildrenPropfind,
  buildMultigetResponse,
  isMultigetReport,
  extractHrefsFromMultiget,
} from './xml.js';

const CALENDAR_PATH = '/caldav/calendars/admin/';

function sendXml(res: Response, status: number, xml: string): void {
  res.status(status).set('Content-Type', 'application/xml; charset=utf-8').send(xml);
}

export function createHandlers(cache: CalDavCache) {
  async function handlePropfind(req: Request, res: Response): Promise<void> {
    const path = req.path;
    const depth = req.headers['depth'] ?? '0';

    logger.debug({ event: 'caldav_propfind', path, depth });
    await cache.refreshIfStale();

    if (path === '/principal/' || path === '/principal') {
      sendXml(res, 207, buildPrincipalPropfind('/caldav/principal/'));
      return;
    }

    if (path === '/calendars/' || path === '/calendars') {
      sendXml(res, 207, buildCalendarHomePropfind('/caldav/calendars/'));
      return;
    }

    if (path === '/calendars/admin/' || path === '/calendars/admin') {
      if (depth === '1') {
        // List all events with etags
        const pages = cache.getAllDated();
        const events = pages.map((p) => ({
          href: `${CALENDAR_PATH}${p.id}.ics`,
          etag: cache.getEtag(p.id) ?? '""',
        }));
        sendXml(res, 207, buildCalendarChildrenPropfind(CALENDAR_PATH, cache.getCtag(), events));
      } else {
        sendXml(res, 207, buildCalendarPropfind(CALENDAR_PATH, cache.getCtag()));
      }
      return;
    }

    // Individual event PROPFIND
    const uidMatch = path.match(/\/calendars\/admin\/(.+)\.ics$/);
    if (uidMatch) {
      const uid = uidMatch[1];
      const pageId = cache.resolveUid(uid);
      const page = cache.getById(pageId);
      if (!page) {
        res.status(404).send('Not Found');
        return;
      }
      const etag = cache.getEtag(pageId) ?? '""';
      sendXml(
        res,
        207,
        buildMultigetResponse([
          {
            href: `${CALENDAR_PATH}${uid}.ics`,
            etag,
            calendarData: wrapCalendar(pageToVEvent(page)),
          },
        ]),
      );
      return;
    }

    res.status(404).send('Not Found');
  }

  async function handleReport(req: Request, res: Response): Promise<void> {
    const body = typeof req.body === 'string' ? req.body : '';

    logger.debug({ event: 'caldav_report', path: req.path, bodyLength: body.length });
    await cache.refreshIfStale();

    if (isMultigetReport(body)) {
      // Return specific events by href
      const hrefs = extractHrefsFromMultiget(body);
      const events = hrefs
        .map((href) => {
          const uidMatch = href.match(/\/([^/]+)\.ics$/);
          if (!uidMatch) return null;
          const uid = uidMatch[1];
          const pageId = cache.resolveUid(uid);
          const page = cache.getById(pageId);
          if (!page) return null;
          return {
            href,
            etag: cache.getEtag(pageId) ?? '""',
            calendarData: wrapCalendar(pageToVEvent(page)),
          };
        })
        .filter((e): e is NonNullable<typeof e> => e !== null);

      sendXml(res, 207, buildMultigetResponse(events));
    } else {
      // calendar-query: return all events
      const pages = cache.getAllDated();
      const events = pages.map((p) => ({
        href: `${CALENDAR_PATH}${p.id}.ics`,
        etag: cache.getEtag(p.id) ?? '""',
        calendarData: wrapCalendar(pageToVEvent(p)),
      }));
      sendXml(res, 207, buildMultigetResponse(events));
    }
  }

  async function handleGet(req: Request, res: Response): Promise<void> {
    const uidMatch = req.path.match(/\/calendars\/admin\/(.+)\.ics$/);
    if (!uidMatch) {
      res.status(404).send('Not Found');
      return;
    }

    await cache.refreshIfStale();
    const uid = uidMatch[1];
    const pageId = cache.resolveUid(uid);
    const page = cache.getById(pageId);

    if (!page) {
      res.status(404).send('Not Found');
      return;
    }

    const etag = cache.getEtag(pageId) ?? '""';
    res
      .status(200)
      .set('Content-Type', 'text/calendar; charset=utf-8')
      .set('ETag', etag)
      .send(wrapCalendar(pageToVEvent(page)));
  }

  async function handlePut(req: Request, res: Response): Promise<void> {
    const uidMatch = req.path.match(/\/calendars\/admin\/(.+)\.ics$/);
    if (!uidMatch) {
      res.status(404).send('Not Found');
      return;
    }

    const uid = uidMatch[1];
    const body = typeof req.body === 'string' ? req.body : '';
    const parsed = parseVEvent(body);

    logger.info({ event: 'caldav_put', uid, summary: parsed.summary, dtstart: parsed.dtstart });

    const pageId = cache.resolveUid(uid);
    const existingPage = cache.getById(pageId);

    if (existingPage) {
      // Update existing task
      const ifMatch = req.headers['if-match'] as string | undefined;
      const currentEtag = cache.getEtag(pageId);
      if (ifMatch && currentEtag && ifMatch !== currentEtag) {
        res.status(412).send('Precondition Failed');
        return;
      }

      const updates: { name?: string; dueDate?: string; status?: string } = {};
      if (parsed.dtstart) updates.dueDate = parsed.dtstart;
      if (parsed.summary) updates.name = parsed.summary;
      if (parsed.status === 'COMPLETED') updates.status = 'done';
      else if (parsed.status === 'CANCELLED') updates.status = 'cancelled';

      await updateAdminFromCalendar(pageId, updates);
      cache.invalidate();

      res.status(204).set('ETag', `"${new Date().toISOString()}"`).send();
    } else {
      // Create new task from Calendar
      const newPageId = await createAdminPage({
        name: parsed.summary || 'Untitled',
        type: 'task',
        dueDate: parsed.dtstart || null,
        status: 'pending',
        priority: 'medium',
        tags: [],
        sourceMessage: 'Created from Apple Calendar',
        sourceMessageId: 0,
        confidence: 1,
      });

      cache.setUidMapping(uid, newPageId);
      cache.invalidate();

      logger.info({ event: 'caldav_created', uid, pageId: newPageId });
      res.status(201).set('ETag', `"${new Date().toISOString()}"`).send();
    }
  }

  async function handleDelete(req: Request, res: Response): Promise<void> {
    const uidMatch = req.path.match(/\/calendars\/admin\/(.+)\.ics$/);
    if (!uidMatch) {
      res.status(404).send('Not Found');
      return;
    }

    const uid = uidMatch[1];
    const pageId = cache.resolveUid(uid);
    const page = cache.getById(pageId);

    if (!page) {
      res.status(404).send('Not Found');
      return;
    }

    logger.info({ event: 'caldav_delete', uid, pageId });
    await updatePageStatus(pageId, 'done');
    cache.invalidate();

    res.status(204).send();
  }

  function handleOptions(_req: Request, res: Response): void {
    res
      .status(200)
      .set('Allow', 'OPTIONS, GET, PUT, DELETE, PROPFIND, REPORT')
      .set('DAV', '1, calendar-access')
      .send();
  }

  return { handlePropfind, handleReport, handleGet, handlePut, handleDelete, handleOptions };
}
