import { Router, type Request, type Response } from 'express';
import { requireAuth, requireAdmin, getCtx } from './middleware.js';
import { serializeUser } from './serialize.js';

export function createAdminRouter(): Router {
  const router = Router();

  router.get('/users', requireAuth, requireAdmin, (req: Request, res: Response) => {
    const ctx = getCtx(req);
    res.json({ users: ctx.store.all().map((u) => serializeUser(u, ctx.config)) });
  });

  return router;
}
