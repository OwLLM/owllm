import type { Request, Response, NextFunction } from 'express';
import type { AppContext } from './context.js';

export function getCtx(req: Request): AppContext {
  return req.app.locals.ctx as AppContext;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const ctx = getCtx(req);
  const userId = req.session.userId;
  if (!userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }

  const user = ctx.store.findByGitHubId(userId);
  if (!user) {
    req.session.destroy(() => {
      res.clearCookie('owllm.sid');
      res.status(401).json({ error: 'user not found' });
    });
    return;
  }

  req.user = user;
  next();
}

export function requireCreator(req: Request, res: Response, next: NextFunction): void {
  if (!req.user?.is_creator) {
    res.status(403).json({ error: 'creator required' });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const ctx = getCtx(req);
  if (!req.user || !ctx.config.adminGitHubIds.has(req.user.github_id)) {
    res.status(403).json({ error: 'admin required' });
    return;
  }
  next();
}
