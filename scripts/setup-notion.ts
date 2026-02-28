import 'dotenv/config';

// NOTE: If re-running this script, delete the old (empty) databases manually
// in Notion before running again, then update your .env with the new IDs.

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_PARENT_PAGE_ID = process.env.NOTION_PARENT_PAGE_ID;

if (!NOTION_API_KEY) {
  console.error('Error: NOTION_API_KEY is not set in environment variables.');
  process.exit(1);
}

if (!NOTION_PARENT_PAGE_ID) {
  console.error('Error: NOTION_PARENT_PAGE_ID is not set in environment variables.');
  process.exit(1);
}

type DatabaseResult = { name: string; envKey: string; id: string };

async function createDatabase(
  title: string,
  properties: Record<string, unknown>
): Promise<string> {
  // SDK v5.11 strips `properties` from bodyParams, so we call the API directly.
  const res = await fetch('https://api.notion.com/v1/databases', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      'Content-Type': 'application/json',
      'Notion-Version': '2022-06-28',
    },
    body: JSON.stringify({
      parent: { type: 'page_id', page_id: NOTION_PARENT_PAGE_ID },
      title: [{ type: 'text', text: { content: title } }],
      properties,
    }),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(`${err.code}: ${err.message}`);
  }

  const data = await res.json();
  return data.id;
}

async function main() {
  console.log('Setting up Notion databases...\n');

  const results: DatabaseResult[] = [];

  // 1. People
  try {
    const id = await createDatabase('People', {
      Name: { title: {} },
      Relationship: {
        select: {
          options: [
            { name: 'friend', color: 'blue' },
            { name: 'colleague', color: 'green' },
            { name: 'acquaintance', color: 'gray' },
            { name: 'family', color: 'purple' },
            { name: 'professional-contact', color: 'yellow' },
          ],
        },
      },
      Context: { rich_text: {} },
      Tags: { multi_select: {} },
      'Source Message': { rich_text: {} },
      'Source Message ID': { number: {} },
      Confidence: { number: {} },
    });
    results.push({ name: 'People', envKey: 'NOTION_DB_PEOPLE', id });
    console.log(`Created People database: ${id}`);
  } catch (err) {
    console.error('Failed to create People database:', err instanceof Error ? err.message : err);
  }

  // 2. Projects
  try {
    const id = await createDatabase('Projects', {
      Name: { title: {} },
      Status: {
        select: {
          options: [
            { name: 'idea', color: 'gray' },
            { name: 'active', color: 'green' },
            { name: 'blocked', color: 'red' },
            { name: 'completed', color: 'blue' },
            { name: 'archived', color: 'brown' },
          ],
        },
      },
      Description: { rich_text: {} },
      Tags: { multi_select: {} },
      Priority: {
        select: {
          options: [
            { name: 'high', color: 'red' },
            { name: 'medium', color: 'yellow' },
            { name: 'low', color: 'gray' },
          ],
        },
      },
      'Source Message': { rich_text: {} },
      'Source Message ID': { number: {} },
      Confidence: { number: {} },
    });
    results.push({ name: 'Projects', envKey: 'NOTION_DB_PROJECTS', id });
    console.log(`Created Projects database: ${id}`);
  } catch (err) {
    console.error('Failed to create Projects database:', err instanceof Error ? err.message : err);
  }

  // 3. Ideas
  try {
    const id = await createDatabase('Ideas', {
      Name: { title: {} },
      Category: {
        select: {
          options: [
            { name: 'business', color: 'blue' },
            { name: 'technical', color: 'green' },
            { name: 'creative', color: 'purple' },
            { name: 'personal', color: 'yellow' },
            { name: 'research', color: 'orange' },
          ],
        },
      },
      Description: { rich_text: {} },
      Tags: { multi_select: {} },
      Potential: {
        select: {
          options: [
            { name: 'high', color: 'green' },
            { name: 'medium', color: 'yellow' },
            { name: 'low', color: 'gray' },
            { name: 'unknown', color: 'default' },
          ],
        },
      },
      'Source Message': { rich_text: {} },
      'Source Message ID': { number: {} },
      Confidence: { number: {} },
    });
    results.push({ name: 'Ideas', envKey: 'NOTION_DB_IDEAS', id });
    console.log(`Created Ideas database: ${id}`);
  } catch (err) {
    console.error('Failed to create Ideas database:', err instanceof Error ? err.message : err);
  }

  // 4. Admin
  try {
    const id = await createDatabase('Admin', {
      Name: { title: {} },
      Type: {
        select: {
          options: [
            { name: 'task', color: 'blue' },
            { name: 'reminder', color: 'yellow' },
            { name: 'appointment', color: 'purple' },
            { name: 'errand', color: 'orange' },
            { name: 'note', color: 'gray' },
          ],
        },
      },
      'Due Date': { date: {} },
      Status: {
        select: {
          options: [
            { name: 'pending', color: 'yellow' },
            { name: 'done', color: 'green' },
            { name: 'cancelled', color: 'gray' },
          ],
        },
      },
      Tags: { multi_select: {} },
      'Source Message': { rich_text: {} },
      'Source Message ID': { number: {} },
      Confidence: { number: {} },
    });
    results.push({ name: 'Admin', envKey: 'NOTION_DB_ADMIN', id });
    console.log(`Created Admin database: ${id}`);
  } catch (err) {
    console.error('Failed to create Admin database:', err instanceof Error ? err.message : err);
  }

  // 5. Inbox Log
  try {
    const id = await createDatabase('Inbox Log', {
      Message: { title: {} },
      'Full Text': { rich_text: {} },
      Category: {
        select: {
          options: [
            { name: 'people', color: 'purple' },
            { name: 'projects', color: 'green' },
            { name: 'ideas', color: 'yellow' },
            { name: 'admin', color: 'red' },
            { name: 'unknown', color: 'gray' },
          ],
        },
      },
      Status: {
        select: {
          options: [
            { name: 'processed', color: 'green' },
            { name: 'pending', color: 'yellow' },
            { name: 'failed', color: 'red' },
            { name: 're-classified', color: 'blue' },
            { name: 'expired', color: 'gray' },
          ],
        },
      },
      Confidence: { number: {} },
      'Telegram Message ID': { number: {} },
      'Notion Page ID': { rich_text: {} },
      Error: { rich_text: {} },
      'Processing Time MS': { number: {} },
    });
    results.push({ name: 'Inbox Log', envKey: 'NOTION_DB_INBOX_LOG', id });
    console.log(`Created Inbox Log database: ${id}`);
  } catch (err) {
    console.error('Failed to create Inbox Log database:', err instanceof Error ? err.message : err);
  }

  if (results.length === 0) {
    console.error('\nNo databases were created. Check your NOTION_API_KEY and NOTION_PARENT_PAGE_ID.');
    process.exit(1);
  }

  console.log('\n--- Add these to your .env file ---\n');
  for (const { envKey, id } of results) {
    console.log(`${envKey}=${id}`);
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Unexpected error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
