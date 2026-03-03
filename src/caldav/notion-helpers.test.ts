import { describe, it, expect } from 'vitest';
import {
  extractTitle,
  extractSelect,
  extractDate,
  extractMultiSelect,
  extractLastEdited,
} from './notion-helpers.js';
import type { NotionPage } from '../notion/schemas.js';

const mockPage: NotionPage = {
  id: 'page-id-abc123',
  properties: {
    Name: { type: 'title', title: [{ plain_text: 'Buy groceries' }] },
    Type: { type: 'select', select: { name: 'task' } },
    Status: { type: 'select', select: { name: 'pending' } },
    Priority: { type: 'select', select: { name: 'high' } },
    'Due Date': { type: 'date', date: { start: '2026-03-05' } },
    Tags: {
      type: 'multi_select',
      multi_select: [{ name: 'personal' }, { name: 'urgent' }],
    },
  },
  created_time: '2026-03-01T10:00:00.000Z',
  last_edited_time: '2026-03-02T15:30:00.000Z',
};

describe('extractTitle', () => {
  it('extracts the Name title', () => {
    expect(extractTitle(mockPage)).toBe('Buy groceries');
  });

  it('returns empty string for missing title', () => {
    const page = { ...mockPage, properties: {} };
    expect(extractTitle(page)).toBe('');
  });
});

describe('extractSelect', () => {
  it('extracts a select value', () => {
    expect(extractSelect(mockPage, 'Status')).toBe('pending');
    expect(extractSelect(mockPage, 'Priority')).toBe('high');
    expect(extractSelect(mockPage, 'Type')).toBe('task');
  });

  it('returns null for missing select', () => {
    expect(extractSelect(mockPage, 'Nonexistent')).toBeNull();
  });
});

describe('extractDate', () => {
  it('extracts the Due Date start value', () => {
    expect(extractDate(mockPage, 'Due Date')).toBe('2026-03-05');
  });

  it('returns null for missing date', () => {
    expect(extractDate(mockPage, 'Nonexistent')).toBeNull();
  });

  it('returns null for null date value', () => {
    const page: NotionPage = {
      ...mockPage,
      properties: { 'Due Date': { type: 'date', date: null } },
    };
    expect(extractDate(page, 'Due Date')).toBeNull();
  });
});

describe('extractMultiSelect', () => {
  it('extracts multi_select values', () => {
    expect(extractMultiSelect(mockPage, 'Tags')).toEqual(['personal', 'urgent']);
  });

  it('returns empty array for missing property', () => {
    expect(extractMultiSelect(mockPage, 'Nonexistent')).toEqual([]);
  });
});

describe('extractLastEdited', () => {
  it('returns last_edited_time as Date', () => {
    const date = extractLastEdited(mockPage);
    expect(date.toISOString()).toBe('2026-03-02T15:30:00.000Z');
  });
});
