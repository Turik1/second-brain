// TypeScript interfaces for Notion database page creation payloads

export interface PeopleEntry {
  name: string;
  relationship: 'friend' | 'colleague' | 'acquaintance' | 'family' | 'professional-contact';
  context: string;
  tags: string[];
  sourceMessage: string;
  sourceMessageId: number;
  confidence: number;
}

export interface ProjectEntry {
  name: string;
  status: 'idea' | 'active' | 'blocked' | 'completed' | 'archived';
  description: string;
  tags: string[];
  priority: 'high' | 'medium' | 'low';
  sourceMessage: string;
  sourceMessageId: number;
  confidence: number;
}

export interface IdeaEntry {
  name: string;
  category: 'business' | 'technical' | 'creative' | 'personal' | 'research';
  description: string;
  tags: string[];
  potential: 'high' | 'medium' | 'low' | 'unknown';
  sourceMessage: string;
  sourceMessageId: number;
  confidence: number;
}

export interface AdminEntry {
  name: string;
  type: 'task' | 'reminder' | 'appointment' | 'errand' | 'note';
  dueDate: string | null;
  status: 'pending' | 'done' | 'cancelled';
  priority: 'high' | 'medium' | 'low';
  tags: string[];
  sourceMessage: string;
  sourceMessageId: number;
  confidence: number;
}

export interface InboxLogEntry {
  message: string;
  fullText: string;
  category: 'people' | 'projects' | 'ideas' | 'admin' | 'unknown';
  status: 'processed' | 'pending' | 'failed' | 're-classified' | 'expired';
  confidence: number;
  notionPageId?: string;
  error?: string;
  telegramMessageId: number;
  processingTimeMs?: number;
}

export interface NotionPage {
  id: string;
  properties: Record<string, unknown>;
  created_time: string;
  last_edited_time: string;
}

export type DatabaseCategory = 'people' | 'projects' | 'ideas' | 'admin' | 'inbox_log';
