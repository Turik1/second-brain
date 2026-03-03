import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CalDavCache } from './cache.js';
import type { NotionPage } from '../notion/schemas.js';

const datedPage: NotionPage = {
  id: 'page-1',
  properties: {
    Name: { type: 'title', title: [{ plain_text: 'Task 1' }] },
    Status: { type: 'select', select: { name: 'pending' } },
    Priority: { type: 'select', select: { name: 'medium' } },
    Type: { type: 'select', select: { name: 'task' } },
    'Due Date': { type: 'date', date: { start: '2026-03-05' } },
    Tags: { type: 'multi_select', multi_select: [] },
  },
  created_time: '2026-03-01T10:00:00.000Z',
  last_edited_time: '2026-03-02T15:30:00.000Z',
};

const undatedPage: NotionPage = {
  id: 'page-2',
  properties: {
    Name: { type: 'title', title: [{ plain_text: 'Task 2' }] },
    Status: { type: 'select', select: { name: 'pending' } },
    'Due Date': { type: 'date', date: null },
  },
  created_time: '2026-03-01T10:00:00.000Z',
  last_edited_time: '2026-03-01T10:00:00.000Z',
};

describe('CalDavCache', () => {
  let cache: CalDavCache;
  const mockFetcher = vi.fn<() => Promise<NotionPage[]>>();

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetcher.mockResolvedValue([datedPage, undatedPage]);
    cache = new CalDavCache(mockFetcher, 60_000);
  });

  it('fetches and filters to dated pages on first access', async () => {
    await cache.refresh();
    const pages = cache.getAllDated();
    expect(pages).toHaveLength(1);
    expect(pages[0].id).toBe('page-1');
  });

  it('returns a page by ID', async () => {
    await cache.refresh();
    expect(cache.getById('page-1')).toBeDefined();
    expect(cache.getById('nonexistent')).toBeUndefined();
  });

  it('computes ctag from max last_edited_time', async () => {
    await cache.refresh();
    expect(cache.getCtag()).toBe('2026-03-02T15:30:00.000Z');
  });

  it('computes etag for a page', async () => {
    await cache.refresh();
    expect(cache.getEtag('page-1')).toBe('"2026-03-02T15:30:00.000Z"');
  });

  it('invalidate forces next refresh to re-fetch', async () => {
    await cache.refresh();
    cache.invalidate();
    await cache.refreshIfStale();
    expect(mockFetcher).toHaveBeenCalledTimes(2);
  });

  it('refreshIfStale skips if within TTL', async () => {
    await cache.refresh();
    await cache.refreshIfStale();
    expect(mockFetcher).toHaveBeenCalledTimes(1);
  });

  it('stores UID mapping for externally created events', async () => {
    await cache.refresh();
    cache.setUidMapping('apple-uid-123', 'page-1');
    expect(cache.resolveUid('apple-uid-123')).toBe('page-1');
    expect(cache.resolveUid('page-1')).toBe('page-1');
  });
});
