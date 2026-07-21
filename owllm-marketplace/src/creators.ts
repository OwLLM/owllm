import { Router, type Request, type Response } from 'express';
import { requireAuth, requireCreator, getCtx } from './middleware.js';
import { serializeUser } from './serialize.js';

export function createCreatorsRouter(): Router {
  const router = Router();

  router.post('/become', requireAuth, (req: Request, res: Response) => {
    const ctx = getCtx(req);
    const user = ctx.store.setCreator(req.user!.github_id, true);
    res.json({ ok: true, user: serializeUser(user, ctx.config) });
  });

  router.get('/profile', requireAuth, requireCreator, (req: Request, res: Response) => {
    const ctx = getCtx(req);
    res.json({ user: serializeUser(req.user!, ctx.config) });
  });

  return router;
}
