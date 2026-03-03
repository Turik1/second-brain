import type { NotionPage } from '../notion/schemas.js';
import { extractDate } from './notion-helpers.js';
import { logger } from '../utils/logger.js';

export class CalDavCache {
  private pages = new Map<string, NotionPage>();
  private uidToPageId = new Map<string, string>();
  private lastRefresh = 0;
  private ctag = '';

  constructor(
    private readonly fetcher: () => Promise<NotionPage[]>,
    private readonly ttlMs: number = 60_000,
  ) {}

  async refresh(): Promise<void> {
    try {
      const allPages = await this.fetcher();
      const dated = allPages.filter((p) => extractDate(p, 'Due Date') !== null);

      this.pages.clear();
      for (const page of dated) {
        this.pages.set(page.id, page);
      }

      // Compute ctag from latest edit
      let maxEdited = '';
      for (const page of dated) {
        if (page.last_edited_time > maxEdited) {
          maxEdited = page.last_edited_time;
        }
      }
      this.ctag = maxEdited || new Date().toISOString();
      this.lastRefresh = Date.now();

      logger.debug({ event: 'caldav_cache_refreshed', count: dated.length, ctag: this.ctag });
    } catch (err) {
      logger.error({ event: 'caldav_cache_refresh_failed', error: err });
      // Keep stale data on failure
    }
  }

  async refreshIfStale(): Promise<void> {
    if (Date.now() - this.lastRefresh > this.ttlMs) {
      await this.refresh();
    }
  }

  invalidate(): void {
    this.lastRefresh = 0;
  }

  getAllDated(): NotionPage[] {
    return Array.from(this.pages.values());
  }

  getById(pageId: string): NotionPage | undefined {
    return this.pages.get(pageId);
  }

  getCtag(): string {
    return this.ctag;
  }

  getEtag(pageId: string): string | undefined {
    const page = this.pages.get(pageId);
    if (!page) return undefined;
    return `"${page.last_edited_time}"`;
  }

  setUidMapping(externalUid: string, pageId: string): void {
    this.uidToPageId.set(externalUid, pageId);
  }

  /** Resolve a UID (from CalDAV URL) to a Notion page ID */
  resolveUid(uid: string): string {
    return this.uidToPageId.get(uid) ?? uid;
  }

}
