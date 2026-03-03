import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';

export function mcpAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers['authorization'];
  const brainKey = req.headers['x-brain-key'] as string | undefined;

  const token =
    authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : brainKey;

  if (token !== config.MCP_ACCESS_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
}
