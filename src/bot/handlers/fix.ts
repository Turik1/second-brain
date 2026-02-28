import { Bot } from 'grammy';
import { logger } from '../../utils/logger.js';
import { classify } from '../../classifier/index.js';
import {
  findInboxLogByMessageId,
  updateInboxLogStatus,
  moveEntry,
  createPeoplePage,
  createProjectsPage,
  createIdeasPage,
  createAdminPage,
} from '../../notion/index.js';
import { config } from '../../config.js';
import type { Category, ClassificationResult } from '../../types.js';

const FIX_PATTERN = /^fix:\s*(people|projects|ideas|admin)\s*$/i;
const REF_PATTERN = /\[ref:(\d+)\]/;

export function registerFixHandler(bot: Bot): void {
  bot.hears(FIX_PATTERN, async (ctx) => {
    const messageId = ctx.message?.message_id;
    const text = ctx.message?.text ?? '';

    // Must be a reply to a receipt message
    const repliedTo = ctx.message?.reply_to_message;
    if (!repliedTo) {
      await ctx.reply('Please reply to a receipt message to use the fix command.');
      return;
    }

    const receiptText = repliedTo.text ?? '';
    const refMatch = receiptText.match(REF_PATTERN);
    if (!refMatch) {
      await ctx.reply(
        "I couldn't find the original entry. Please resend the thought.",
      );
      return;
    }

    const originalMessageId = parseInt(refMatch[1], 10);
    const categoryMatch = text.match(FIX_PATTERN);
    const newCategory = categoryMatch![1].toLowerCase() as Category;

    logger.info({ event: 'fix_requested', messageId, originalMessageId, newCategory });

    // Look up inbox log entry by original message ID
    let inboxPage;
    try {
      inboxPage = await findInboxLogByMessageId(originalMessageId);
    } catch (err) {
      logger.error({ event: 'error', messageId, stage: 'fix_lookup', error: String(err) });
      await ctx.reply("I couldn't find the original entry. Please resend the thought.");
      return;
    }

    if (!inboxPage) {
      await ctx.reply("I couldn't find the original entry. Please resend the thought.");
      return;
    }

    // The enriched findInboxLogByMessageId returns fullText, notionPageId, pageId directly
    const fullText = inboxPage.fullText;

    if (!fullText) {
      await ctx.reply("I couldn't retrieve the original message text. Please resend the thought.");
      return;
    }

    // Re-classify with new category context, then force category to user selection
    let classification: ClassificationResult;
    try {
      classification = await classify(fullText);
      classification = { ...classification, category: newCategory, confidence: 1.0 };
    } catch (err) {
      logger.error({ event: 'error', messageId, stage: 'fix_classify', error: String(err) });
      await ctx.reply('Failed to re-classify. Please try again.');
      return;
    }

    // Get existing notion page ID to archive
    const existingNotionPageId = inboxPage.notionPageId;

    // Determine target database ID
    const targetDbId = getTargetDbId(newCategory);

    // Create new page in correct database (archive old if it exists)
    let newPageId: string;
    try {
      if (existingNotionPageId) {
        const newProperties = buildNotionProperties(classification, fullText, originalMessageId);
        newPageId = await moveEntry('', targetDbId, existingNotionPageId, newProperties);
      } else {
        newPageId = await createPageInCategory(classification, fullText, originalMessageId, newCategory);
      }
      logger.info({
        event: 'filed',
        messageId: originalMessageId,
        category: newCategory,
        notionPageId: newPageId,
        durationMs: 0,
      });
    } catch (err) {
      logger.error({ event: 'error', messageId, stage: 'fix_file', error: String(err) });
      await ctx.reply('Failed to move the entry. Please try again.');
      return;
    }

    // Update inbox log using the enriched pageId
    try {
      await updateInboxLogStatus(inboxPage.pageId, 're-classified', newPageId);
    } catch (err) {
      logger.warn({ messageId, error: String(err) }, 'Failed to update inbox log after fix');
    }

    const categoryLabel = newCategory.charAt(0).toUpperCase() + newCategory.slice(1);
    await ctx.reply(`Moved to ${categoryLabel}: ${classification.title}`);
  });
}

function getTargetDbId(category: Category): string {
  switch (category) {
    case 'people':
      return config.NOTION_DB_PEOPLE;
    case 'projects':
      return config.NOTION_DB_PROJECTS;
    case 'ideas':
      return config.NOTION_DB_IDEAS;
    case 'admin':
    default:
      return config.NOTION_DB_ADMIN;
  }
}

async function createPageInCategory(
  classification: ClassificationResult,
  text: string,
  messageId: number,
  category: Category,
): Promise<string> {
  const { confidence, title, tags, extras } = classification;

  switch (category) {
    case 'people':
      return createPeoplePage({
        name: title,
        relationship: (extras['relationship'] as string) || 'acquaintance',
        context: (extras['context'] as string) || text,
        tags,
        sourceMessage: text,
        sourceMessageId: messageId,
        confidence,
      } as import('../../notion/schemas.js').PeopleEntry);

    case 'projects':
      return createProjectsPage({
        name: title,
        status: (extras['status'] as string) || 'idea',
        description: (extras['description'] as string) || text,
        tags,
        priority: (extras['priority'] as string) || 'medium',
        sourceMessage: text,
        sourceMessageId: messageId,
        confidence,
      } as import('../../notion/schemas.js').ProjectEntry);

    case 'ideas':
      return createIdeasPage({
        name: title,
        category: (extras['idea_category'] as string) || 'personal',
        description: (extras['description'] as string) || text,
        tags,
        potential: (extras['potential'] as string) || 'unknown',
        sourceMessage: text,
        sourceMessageId: messageId,
        confidence,
      } as import('../../notion/schemas.js').IdeaEntry);

    case 'admin':
    default:
      return createAdminPage({
        name: title,
        type: (extras['type'] as string) || 'note',
        dueDate: (extras['due_date'] as string) || null,
        status: 'pending',
        tags,
        sourceMessage: text,
        sourceMessageId: messageId,
        confidence,
      } as import('../../notion/schemas.js').AdminEntry);
  }
}

function buildNotionProperties(
  classification: ClassificationResult,
  text: string,
  messageId: number,
): Record<string, unknown> {
  const { category, confidence, title, tags, extras } = classification;

  function richText(content: string) {
    return { rich_text: [{ type: 'text', text: { content: content.slice(0, 2000) } }] };
  }
  function titleProp(content: string) {
    return { title: [{ type: 'text', text: { content: content.slice(0, 2000) } }] };
  }
  function selectProp(name: string) {
    return { select: { name } };
  }
  function multiSelectProp(items: string[]) {
    return { multi_select: items.map((name) => ({ name: name.slice(0, 100) })) };
  }
  function numberProp(value: number) {
    return { number: value };
  }

  const base = {
    'Source Message': richText(text),
    'Source Message ID': numberProp(messageId),
    Confidence: numberProp(confidence),
    Tags: multiSelectProp(tags),
  };

  switch (category) {
    case 'people':
      return {
        Name: titleProp(title),
        Relationship: selectProp((extras['relationship'] as string) || 'acquaintance'),
        Context: richText((extras['context'] as string) || text),
        ...base,
      };
    case 'projects':
      return {
        Name: titleProp(title),
        Status: selectProp((extras['status'] as string) || 'idea'),
        Description: richText((extras['description'] as string) || text),
        Priority: selectProp((extras['priority'] as string) || 'medium'),
        ...base,
      };
    case 'ideas':
      return {
        Name: titleProp(title),
        Category: selectProp((extras['idea_category'] as string) || 'personal'),
        Description: richText((extras['description'] as string) || text),
        Potential: selectProp((extras['potential'] as string) || 'unknown'),
        ...base,
      };
    case 'admin':
    default:
      return {
        Name: titleProp(title),
        Type: selectProp((extras['type'] as string) || 'note'),
        Status: selectProp('pending'),
        ...base,
      };
  }
}

