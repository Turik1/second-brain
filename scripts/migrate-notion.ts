import 'dotenv/config';
import { Client } from '@notionhq/client';
import { config } from '../src/config.js';
import { captureThought } from '../src/brain/index.js';
import { runMigrations, closePool } from '../src/db/index.js';

const notion = new Client({ auth: config.NOTION_API_KEY });

const DATABASES = [
  { id: config.NOTION_DB_PEOPLE, category: 'people' },
  { id: config.NOTION_DB_PROJECTS, category: 'projects' },
  { id: config.NOTION_DB_IDEAS, category: 'ideas' },
  { id: config.NOTION_DB_ADMIN, category: 'admin' },
];

function extractTitle(page: any): string {
  const titleProp = Object.values(page.properties).find(
    (p: any) => p.type === 'title'
  ) as any;
  return titleProp?.title?.map((t: any) => t.plain_text).join('') ?? 'Untitled';
}

function extractRichText(page: any, propName: string): string {
  const prop = page.properties[propName];
  if (!prop || prop.type !== 'rich_text') return '';
  return prop.rich_text.map((t: any) => t.plain_text).join('');
}

function extractSelect(page: any, propName: string): string {
  const prop = page.properties[propName];
  if (!prop || prop.type !== 'select' || !prop.select) return '';
  return prop.select.name;
}

function extractMultiSelect(page: any, propName: string): string[] {
  const prop = page.properties[propName];
  if (!prop || prop.type !== 'multi_select') return [];
  return prop.multi_select.map((s: any) => s.name);
}

function extractDate(page: any, propName: string): string {
  const prop = page.properties[propName];
  if (!prop || prop.type !== 'date' || !prop.date) return '';
  return prop.date.start;
}

function pageToContent(page: any, category: string): string {
  const title = extractTitle(page);
  const parts = [title];

  switch (category) {
    case 'people': {
      const relationship = extractSelect(page, 'Relationship');
      const context = extractRichText(page, 'Context');
      if (relationship) parts.push(`Beziehung: ${relationship}`);
      if (context) parts.push(context);
      break;
    }
    case 'projects': {
      const status = extractSelect(page, 'Status');
      const description = extractRichText(page, 'Description');
      const priority = extractSelect(page, 'Priority');
      const nextAction = extractRichText(page, 'Next Action');
      if (status) parts.push(`Status: ${status}`);
      if (priority) parts.push(`Priorität: ${priority}`);
      if (description) parts.push(description);
      if (nextAction) parts.push(`Nächster Schritt: ${nextAction}`);
      break;
    }
    case 'ideas': {
      const ideaCategory = extractSelect(page, 'Category');
      const description = extractRichText(page, 'Description');
      const potential = extractSelect(page, 'Potential');
      if (ideaCategory) parts.push(`Kategorie: ${ideaCategory}`);
      if (potential) parts.push(`Potenzial: ${potential}`);
      if (description) parts.push(description);
      break;
    }
    case 'admin': {
      const type = extractSelect(page, 'Type');
      const status = extractSelect(page, 'Status');
      const priority = extractSelect(page, 'Priority');
      const dueDate = extractDate(page, 'Due Date');
      if (type) parts.push(`Typ: ${type}`);
      if (status) parts.push(`Status: ${status}`);
      if (priority) parts.push(`Priorität: ${priority}`);
      if (dueDate) parts.push(`Fällig: ${dueDate}`);
      break;
    }
  }

  const tags = extractMultiSelect(page, 'Tags');
  if (tags.length) parts.push(`Tags: ${tags.join(', ')}`);

  return parts.join('. ');
}

async function fetchAllPages(databaseId: string): Promise<any[]> {
  const pages: any[] = [];
  let cursor: string | undefined;

  do {
    const response: any = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 100,
    });
    pages.push(...response.results);
    cursor = response.has_more ? response.next_cursor : undefined;

    // Rate limit: Notion allows ~3 req/s
    await new Promise((r) => setTimeout(r, 400));
  } while (cursor);

  return pages;
}

async function main() {
  console.log('Running migrations...');
  await runMigrations();

  let totalMigrated = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const { id, category } of DATABASES) {
    console.log(`\nFetching ${category} from Notion...`);
    const pages = await fetchAllPages(id);
    console.log(`Found ${pages.length} ${category} entries`);

    for (const page of pages) {
      const content = pageToContent(page, category);
      const result = await captureThought({
        content,
        source: 'migration',
        source_id: page.id,
      });

      if (result) {
        totalMigrated++;
        process.stdout.write('.');
      } else {
        // null means dedup (already exists) or error
        totalSkipped++;
        process.stdout.write('s');
      }

      // Rate limit for Voyage API
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  console.log(`\n\nMigration complete:`);
  console.log(`  Migrated: ${totalMigrated}`);
  console.log(`  Skipped:  ${totalSkipped}`);
  console.log(`  Failed:   ${totalFailed}`);

  await closePool();
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
