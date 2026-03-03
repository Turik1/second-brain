import type { NotionPage } from '../notion/schemas.js';

function extractText(prop: unknown): string {
  if (!Array.isArray(prop)) return '';
  return (prop as Array<{ plain_text?: string }>)
    .map((t) => t.plain_text ?? '')
    .join('');
}

export function extractTitle(page: NotionPage): string {
  for (const val of Object.values(page.properties)) {
    if (typeof val !== 'object' || val === null) continue;
    const v = val as Record<string, unknown>;
    if (v['type'] === 'title' && Array.isArray(v['title'])) {
      return extractText(v['title']);
    }
  }
  return '';
}

export function extractSelect(page: NotionPage, propertyName: string): string | null {
  const prop = page.properties[propertyName] as Record<string, unknown> | undefined;
  if (!prop || prop['type'] !== 'select' || !prop['select']) return null;
  return (prop['select'] as Record<string, unknown>)['name'] as string;
}

export function extractDate(page: NotionPage, propertyName: string): string | null {
  const prop = page.properties[propertyName] as Record<string, unknown> | undefined;
  if (!prop || prop['type'] !== 'date' || !prop['date']) return null;
  return (prop['date'] as Record<string, unknown>)['start'] as string;
}

export function extractMultiSelect(page: NotionPage, propertyName: string): string[] {
  const prop = page.properties[propertyName] as Record<string, unknown> | undefined;
  if (!prop || prop['type'] !== 'multi_select' || !Array.isArray(prop['multi_select'])) return [];
  return (prop['multi_select'] as Array<{ name: string }>).map((s) => s.name);
}

export function extractLastEdited(page: NotionPage): Date {
  return new Date(page.last_edited_time);
}
