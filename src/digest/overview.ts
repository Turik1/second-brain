import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { splitTelegramMessage } from '../utils/telegram.js';
import { queryRecentEntries, queryByProperty, queryPendingAdmin, summarizePage } from '../notion/index.js';
import { OVERVIEW_SYSTEM_PROMPT } from './prompt.js';

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

const PAGE_SIZE = 30;
const PEOPLE_DAYS = 30;
const TOKEN_BUDGET_CHARS = 8000 * 4;

interface OverviewData {
  activeProjects: string[];
  blockedProjects: string[];
  pendingAdmin: string[];
  recentPeople: string[];
  highIdeas: string[];
  mediumIdeas: string[];
  unknownIdeaCount: number;
}

function formatOverviewInput(data: OverviewData): string {
  const sections: string[] = [];

  // Projects
  const allProjects = [
    ...data.activeProjects.map((p) => `• [active] ${p}`),
    ...data.blockedProjects.map((p) => `• [blocked] ${p}`),
  ];
  sections.push(
    `## PROJECTS (${allProjects.length} active/blocked)\n${allProjects.length > 0 ? allProjects.join('\n') : '(none)'}`,
  );

  // Admin
  sections.push(
    `## PENDING ADMIN (${data.pendingAdmin.length})\n${data.pendingAdmin.length > 0 ? data.pendingAdmin.map((a) => `• ${a}`).join('\n') : '(none)'}`,
  );

  // People
  sections.push(
    `## RECENT PEOPLE (last ${PEOPLE_DAYS} days, ${data.recentPeople.length} entries)\n${data.recentPeople.length > 0 ? data.recentPeople.map((p) => `• ${p}`).join('\n') : '(none)'}`,
  );

  // Ideas
  const ideaLines = [
    ...data.highIdeas.map((i) => `• [high] ${i}`),
    ...data.mediumIdeas.map((i) => `• [medium] ${i}`),
  ];
  const unknownNote =
    data.unknownIdeaCount > 0 ? `\n(${data.unknownIdeaCount} uncurated ideas with unknown potential)` : '';
  sections.push(
    `## IDEAS (${ideaLines.length} curated${unknownNote})\n${ideaLines.length > 0 ? ideaLines.join('\n') : '(none)'}`,
  );

  return sections.join('\n\n');
}

export async function generateOverview(sendFn: (text: string) => Promise<void>): Promise<void> {
  const startMs = Date.now();
  const peopleSince = new Date(Date.now() - PEOPLE_DAYS * 24 * 60 * 60 * 1000);

  logger.info({ event: 'digest_start', type: 'overview' });

  const [activeProjects, blockedProjects, pendingAdmin, recentPeople, highIdeas, mediumIdeas, unknownIdeas] =
    await Promise.all([
      queryByProperty(config.NOTION_DB_PROJECTS, 'Status', 'active', PAGE_SIZE),
      queryByProperty(config.NOTION_DB_PROJECTS, 'Status', 'blocked', PAGE_SIZE),
      queryPendingAdmin(PAGE_SIZE),
      queryRecentEntries(config.NOTION_DB_PEOPLE, peopleSince, 20),
      queryByProperty(config.NOTION_DB_IDEAS, 'Potential', 'high', PAGE_SIZE),
      queryByProperty(config.NOTION_DB_IDEAS, 'Potential', 'medium', PAGE_SIZE),
      queryByProperty(config.NOTION_DB_IDEAS, 'Potential', 'unknown', PAGE_SIZE),
    ]);

  const totalEntries =
    activeProjects.length +
    blockedProjects.length +
    pendingAdmin.length +
    recentPeople.length +
    highIdeas.length +
    mediumIdeas.length;

  if (totalEntries === 0 && unknownIdeas.length === 0) {
    await sendFn('Your second brain is empty. Start capturing thoughts!');
    logger.info({ event: 'digest_sent', type: 'overview', entriesCount: 0, durationMs: Date.now() - startMs });
    return;
  }

  const data: OverviewData = {
    activeProjects: activeProjects.map((p) => summarizePage(p).slice(0, 200)),
    blockedProjects: blockedProjects.map((p) => summarizePage(p).slice(0, 200)),
    pendingAdmin: pendingAdmin.map((p) => summarizePage(p).slice(0, 200)),
    recentPeople: recentPeople.map((p) => summarizePage(p).slice(0, 200)),
    highIdeas: highIdeas.map((p) => summarizePage(p).slice(0, 200)),
    mediumIdeas: mediumIdeas.map((p) => summarizePage(p).slice(0, 200)),
    unknownIdeaCount: unknownIdeas.length,
  };

  let formattedInput = formatOverviewInput(data);
  if (formattedInput.length > TOKEN_BUDGET_CHARS) {
    formattedInput = formattedInput.slice(0, TOKEN_BUDGET_CHARS) + '\n\n[Input truncated to fit token budget]';
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 2048,
    system: OVERVIEW_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: formattedInput }],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  const overview = textBlock?.type === 'text' ? textBlock.text : 'Could not generate overview.';

  const parts = splitTelegramMessage(overview);
  for (const part of parts) {
    await sendFn(part);
  }

  const durationMs = Date.now() - startMs;
  logger.info({ event: 'digest_sent', type: 'overview', entriesCount: totalEntries, durationMs });
}
