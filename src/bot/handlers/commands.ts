import { Bot, InlineKeyboard } from 'grammy';
import { logger } from '../../utils/logger.js';
import { findThoughtBySourceId, updateThoughtStatus, updateThoughtDueDate, listOpenTasks, insertKnowledge, listKnowledge, deleteKnowledge } from '../../db/index.js';
import { generateDailyDigest, generateWeeklyDigest, generateOverview } from '../../digest/index.js';
import { invalidateKnowledgeCache } from '../../extractor/extract.js';

// In-memory map for callback data (Telegram 64-byte limit on callback_data)
const openTaskMap = new Map<number, string>(); // numeric key -> thought UUID
let openTaskCounter = 0;

const knowledgeMap = new Map<number, string>();
let knowledgeCounter = 0;

/** Parse German/English date expressions into ISO date string. Returns null if unparseable. */
function parseDate(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // ISO date: 2026-03-15
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  // DD.MM.YYYY or DD.MM.
  const dotMatch = trimmed.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})?$/);
  if (dotMatch) {
    const day = parseInt(dotMatch[1]);
    const month = parseInt(dotMatch[2]) - 1;
    const year = dotMatch[3] ? parseInt(dotMatch[3]) : today.getFullYear();
    const d = new Date(year, month, day);
    return d.toISOString().slice(0, 10);
  }

  // +Nd (e.g. +3d, +1d)
  const plusDays = trimmed.match(/^\+(\d+)d$/);
  if (plusDays) {
    const d = new Date(today);
    d.setDate(d.getDate() + parseInt(plusDays[1]));
    return d.toISOString().slice(0, 10);
  }

  // +Nw (e.g. +2w)
  const plusWeeks = trimmed.match(/^\+(\d+)w$/);
  if (plusWeeks) {
    const d = new Date(today);
    d.setDate(d.getDate() + parseInt(plusWeeks[1]) * 7);
    return d.toISOString().slice(0, 10);
  }

  // German relative expressions
  const relative: Record<string, number> = {
    'heute': 0, 'today': 0,
    'morgen': 1, 'tomorrow': 1,
    'übermorgen': 2,
  };
  if (relative[trimmed] !== undefined) {
    const d = new Date(today);
    d.setDate(d.getDate() + relative[trimmed]);
    return d.toISOString().slice(0, 10);
  }

  // "nächste woche" / "next week" → next Monday
  if (trimmed === 'nächste woche' || trimmed === 'next week') {
    const d = new Date(today);
    const daysUntilMonday = (8 - d.getDay()) % 7 || 7;
    d.setDate(d.getDate() + daysUntilMonday);
    return d.toISOString().slice(0, 10);
  }

  // German weekday names → next occurrence
  const weekdays: Record<string, number> = {
    'montag': 1, 'dienstag': 2, 'mittwoch': 3, 'donnerstag': 4,
    'freitag': 5, 'samstag': 6, 'sonntag': 0,
    'monday': 1, 'tuesday': 2, 'wednesday': 3, 'thursday': 4,
    'friday': 5, 'saturday': 6, 'sunday': 0,
  };
  if (weekdays[trimmed] !== undefined) {
    const target = weekdays[trimmed];
    const d = new Date(today);
    const diff = (target - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + diff);
    return d.toISOString().slice(0, 10);
  }

  return null;
}

export function registerCommandHandlers(bot: Bot, sendToUser: (text: string) => Promise<void>): void {
  bot.command('start', async (ctx) => {
    logger.info({ messageId: ctx.message?.message_id }, 'Command: /start');
    await ctx.reply(
      '<b>Second Brain</b> is ready!\n\n' +
        'Schick mir einfach eine Nachricht — ich erfasse und speichere sie automatisch.\n\n' +
        'Use /help to see all commands.',
      { parse_mode: 'HTML' },
    );
  });

  bot.command('help', async (ctx) => {
    logger.info({ messageId: ctx.message?.message_id }, 'Command: /help');
    await ctx.reply(
      '<b>Commands:</b>\n' +
        '/start — Introduction\n' +
        '/help — This message\n' +
        '/open — Offene Aufgaben anzeigen\n' +
        '/done — (Reply) Aufgabe als erledigt markieren\n' +
        '/delete — (Reply) Gedanke löschen\n' +
        '/postpone — (Reply) Due Date ändern\n' +
        '/correct — Wissen beibringen (z.B. /correct Pavel ist ein Hund)\n' +
        '/knowledge — Gespeichertes Wissen anzeigen/löschen\n' +
        '/digest — Daily digest (last 24h)\n' +
        '/weekly — Weekly digest (last 7 days)\n' +
        '/overview — Current state overview\n\n' +
        '<b>Datum-Formate für /postpone:</b>\n' +
        'morgen, übermorgen, montag, nächste woche\n' +
        '+3d, +2w, 15.03., 2026-03-15\n\n' +
        'Schick mir einfach Text, um Gedanken zu erfassen.',
      { parse_mode: 'HTML' },
    );
  });

  bot.command('done', async (ctx) => {
    const replyTo = ctx.message?.reply_to_message;
    if (!replyTo) {
      await ctx.reply('Antworte auf eine Nachricht mit /done, um sie als erledigt zu markieren.');
      return;
    }

    // The receipt is a reply to the original — get the original message ID
    // grammY strips reply_to_message from ReplyMessage type, but it exists at runtime
    const nested = replyTo as { reply_to_message?: { message_id: number } };
    const originalMessageId = nested.reply_to_message?.message_id ?? replyTo.message_id;
    const chatId = ctx.chat.id;

    const thought = await findThoughtBySourceId(String(originalMessageId), chatId);
    if (!thought) {
      await ctx.reply('Gedanke nicht gefunden.');
      return;
    }

    if (thought.status === 'done') {
      await ctx.reply('Bereits erledigt.');
      return;
    }

    const updated = await updateThoughtStatus(thought.id, 'done');
    if (updated) {
      await ctx.reply(`✓ Erledigt: ${updated.title ?? updated.content.slice(0, 50)}`);
      logger.info({ thoughtId: updated.id, title: updated.title }, 'Thought marked done');
    } else {
      await ctx.reply('Fehler beim Aktualisieren.');
    }
  });

  bot.command('delete', async (ctx) => {
    const replyTo = ctx.message?.reply_to_message;
    if (!replyTo) {
      await ctx.reply('Antworte auf eine Nachricht mit /delete, um sie zu löschen.');
      return;
    }

    const nested = replyTo as { reply_to_message?: { message_id: number } };
    const originalMessageId = nested.reply_to_message?.message_id ?? replyTo.message_id;
    const chatId = ctx.chat.id;

    const thought = await findThoughtBySourceId(String(originalMessageId), chatId);
    if (!thought) {
      await ctx.reply('Gedanke nicht gefunden.');
      return;
    }

    const updated = await updateThoughtStatus(thought.id, 'cancelled');
    if (updated) {
      await ctx.reply(`Gelöscht: ${updated.title ?? updated.content.slice(0, 50)}`);
      logger.info({ thoughtId: updated.id, title: updated.title }, 'Thought cancelled');
    } else {
      await ctx.reply('Fehler beim Löschen.');
    }
  });

  bot.command('postpone', async (ctx) => {
    const replyTo = ctx.message?.reply_to_message;
    if (!replyTo) {
      await ctx.reply(
        'Antworte auf eine Nachricht mit /postpone <datum>, um das Fälligkeitsdatum zu ändern.\n\n' +
          'Beispiele: /postpone morgen, /postpone +3d, /postpone 15.03., /postpone nächste woche'
      );
      return;
    }

    const dateArg = ctx.message?.text?.replace(/^\/postpone\s*/i, '').trim();
    if (!dateArg) {
      await ctx.reply(
        'Bitte gib ein Datum an.\n\nBeispiele: /postpone morgen, /postpone +3d, /postpone freitag, /postpone 15.03.'
      );
      return;
    }

    const newDate = parseDate(dateArg);
    if (!newDate) {
      await ctx.reply(
        `Konnte "${dateArg}" nicht als Datum erkennen.\n\n` +
          'Formate: morgen, übermorgen, montag, nächste woche, +3d, +2w, 15.03., 2026-03-15'
      );
      return;
    }

    const nested = replyTo as { reply_to_message?: { message_id: number } };
    const originalMessageId = nested.reply_to_message?.message_id ?? replyTo.message_id;
    const chatId = ctx.chat.id;

    const thought = await findThoughtBySourceId(String(originalMessageId), chatId);
    if (!thought) {
      await ctx.reply('Gedanke nicht gefunden.');
      return;
    }

    const updated = await updateThoughtDueDate(thought.id, newDate);
    if (updated) {
      await ctx.reply(`📅 Verschoben auf ${newDate}: ${updated.title ?? updated.content.slice(0, 50)}`);
      logger.info({ thoughtId: updated.id, newDate, title: updated.title }, 'Due date updated via /postpone');
    } else {
      await ctx.reply('Fehler beim Aktualisieren.');
    }
  });

  bot.command('open', async (ctx) => {
    const tasks = await listOpenTasks(20);

    if (tasks.length === 0) {
      await ctx.reply('Keine offenen Aufgaben. Alles erledigt!');
      return;
    }

    // Reset counter and map for each /open call
    openTaskMap.clear();
    openTaskCounter = 0;

    const lines = [`<b>Offene Aufgaben (${tasks.length})</b>\n`];
    const keyboard = new InlineKeyboard();

    for (const t of tasks) {
      const key = ++openTaskCounter;
      openTaskMap.set(key, t.id);

      const title = t.title ?? t.content.slice(0, 60);
      let line = `${key}. ${title}`;
      if (t.due_date) {
        const dueStr = new Date(t.due_date).toISOString().slice(0, 10);
        const today = new Date().toISOString().slice(0, 10);
        line += dueStr < today ? ` ⚠️ ${dueStr}` : ` 📅 ${dueStr}`;
      }
      if (t.priority === 'high') line += ' 🔴';
      lines.push(line);

      keyboard
        .text(`✓ ${key}`, `done:${key}`)
        .text(`✗ ${key}`, `del:${key}`)
        .text(`📅 ${key}`, `post:${key}`)
        .row();
    }

    await ctx.reply(lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  });

  bot.callbackQuery(/^done:(\d+)$/, async (ctx) => {
    const key = parseInt(ctx.match![1]);
    const thoughtId = openTaskMap.get(key);

    if (!thoughtId) {
      await ctx.answerCallbackQuery({ text: 'Aufgabe nicht mehr verfügbar.' });
      return;
    }

    const updated = await updateThoughtStatus(thoughtId, 'done');
    openTaskMap.delete(key);

    if (updated) {
      await ctx.answerCallbackQuery({ text: `✓ ${updated.title ?? 'Erledigt'}` });
      logger.info({ thoughtId: updated.id, title: updated.title }, 'Thought marked done via button');
    } else {
      await ctx.answerCallbackQuery({ text: 'Fehler beim Aktualisieren.' });
    }
  });

  bot.callbackQuery(/^del:(\d+)$/, async (ctx) => {
    const key = parseInt(ctx.match![1]);
    const thoughtId = openTaskMap.get(key);

    if (!thoughtId) {
      await ctx.answerCallbackQuery({ text: 'Aufgabe nicht mehr verfügbar.' });
      return;
    }

    const updated = await updateThoughtStatus(thoughtId, 'cancelled');
    openTaskMap.delete(key);

    if (updated) {
      await ctx.answerCallbackQuery({ text: `Gelöscht: ${updated.title ?? 'Entfernt'}` });
      logger.info({ thoughtId: updated.id, title: updated.title }, 'Thought cancelled via button');
    } else {
      await ctx.answerCallbackQuery({ text: 'Fehler beim Löschen.' });
    }
  });

  // Postpone button from /open → show date options
  bot.callbackQuery(/^post:(\d+)$/, async (ctx) => {
    const key = parseInt(ctx.match![1]);
    const thoughtId = openTaskMap.get(key);

    if (!thoughtId) {
      await ctx.answerCallbackQuery({ text: 'Aufgabe nicht mehr verfügbar.' });
      return;
    }

    const dateKeyboard = new InlineKeyboard()
      .text('Morgen', `setdate:${key}:+1d`)
      .text('+3 Tage', `setdate:${key}:+3d`)
      .row()
      .text('Nächste Woche', `setdate:${key}:+1w`)
      .text('+2 Wochen', `setdate:${key}:+2w`)
      .row();

    await ctx.answerCallbackQuery();
    await ctx.reply('Verschieben auf:', { reply_markup: dateKeyboard });
  });

  // Set date from postpone option buttons
  bot.callbackQuery(/^setdate:(\d+):(.+)$/, async (ctx) => {
    const key = parseInt(ctx.match![1]);
    const dateExpr = ctx.match![2];
    const thoughtId = openTaskMap.get(key);

    if (!thoughtId) {
      await ctx.answerCallbackQuery({ text: 'Aufgabe nicht mehr verfügbar.' });
      return;
    }

    const newDate = parseDate(dateExpr);
    if (!newDate) {
      await ctx.answerCallbackQuery({ text: 'Fehler beim Parsen des Datums.' });
      return;
    }

    const updated = await updateThoughtDueDate(thoughtId, newDate);
    if (updated) {
      await ctx.answerCallbackQuery({ text: `📅 ${newDate}` });
      // Edit the "Verschieben auf:" message to show the result
      try {
        await ctx.editMessageText(`📅 Verschoben auf ${newDate}: ${updated.title ?? updated.content.slice(0, 50)}`);
      } catch {
        // Ignore if message can't be edited
      }
      logger.info({ thoughtId: updated.id, newDate, title: updated.title }, 'Due date updated via button');
    } else {
      await ctx.answerCallbackQuery({ text: 'Fehler beim Aktualisieren.' });
    }
  });

  bot.command('correct', async (ctx) => {
    const fact = ctx.message?.text?.replace(/^\/correct\s*/i, '').trim();
    if (!fact) {
      await ctx.reply('Schreib: /correct <Fakt>\n\nBeispiel: /correct Pavel ist unser Hund, keine Person');
      return;
    }

    await insertKnowledge(fact);
    invalidateKnowledgeCache();
    await ctx.reply(`💡 Gelernt: ${fact}`);
    logger.info({ fact }, 'Knowledge fact added');
  });

  bot.command('knowledge', async (ctx) => {
    const facts = await listKnowledge();

    if (facts.length === 0) {
      await ctx.reply('Noch kein Wissen gespeichert. Nutze /correct um etwas beizubringen.');
      return;
    }

    knowledgeMap.clear();
    knowledgeCounter = 0;

    const lines = [`<b>Wissen (${facts.length})</b>\n`];
    const keyboard = new InlineKeyboard();

    for (const f of facts) {
      const key = ++knowledgeCounter;
      knowledgeMap.set(key, f.id);
      lines.push(`${key}. ${f.fact}`);
      keyboard.text(`✗ ${key}`, `delknow:${key}`).row();
    }

    await ctx.reply(lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  });

  bot.callbackQuery(/^delknow:(\d+)$/, async (ctx) => {
    const key = parseInt(ctx.match![1]);
    const knowledgeId = knowledgeMap.get(key);

    if (!knowledgeId) {
      await ctx.answerCallbackQuery({ text: 'Eintrag nicht mehr verfügbar.' });
      return;
    }

    const deleted = await deleteKnowledge(knowledgeId);
    knowledgeMap.delete(key);

    if (deleted) {
      invalidateKnowledgeCache();
      await ctx.answerCallbackQuery({ text: 'Wissen gelöscht.' });
      logger.info({ knowledgeId }, 'Knowledge fact deleted');
    } else {
      await ctx.answerCallbackQuery({ text: 'Fehler beim Löschen.' });
    }
  });

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
}
