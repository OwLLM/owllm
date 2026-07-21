import { Router, type Request, type Response, type NextFunction } from 'express';
import crypto from 'crypto';
import type { AppContext } from './context.js';
import { exchangeCodeForToken, fetchGitHubUser } from './github.js';
import { requireAuth, getCtx } from './middleware.js';
import { serializeUser } from './serialize.js';
import './types.js';

export function createAuthRouter(): Router {
  const router = Router();

  router.get('/github', (req: Request, res: Response) => {
    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', getCtx(req).config.githubClientId);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', 'read:user user:email');
    res.redirect(url.toString());
  });

  router.get('/github/callback', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const code = req.query.code;
      const state = req.query.state;
      if (typeof code !== 'string' || typeof state !== 'string') {
        res.status(400).json({ error: 'invalid params' });
        return;
      }

      if (!req.session.oauthState || req.session.oauthState !== state) {
        res.status(403).json({ error: 'invalid state' });
        return;
      }
      delete req.session.oauthState;

      const ctx = getCtx(req);
      const token = await exchangeCodeForToken(code, ctx.config);
      const gh = await fetchGitHubUser(token);
      const githubId = String(gh.id);

      let user = ctx.store.findByGitHubId(githubId);
      if (!user) {
        user = ctx.store.create(githubId, gh.login, gh.email);
      } else {
        user = ctx.store.updateLogin(githubId, gh.login, gh.email);
      }

      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.userId = user.github_id;
        req.session.save((saveErr) => {
          if (saveErr) return next(saveErr);
          res.redirect('/auth/me');
        });
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/signout', (req: Request, res: Response) => {
    req.session.destroy(() => {
      res.clearCookie('owllm.sid');
      res.json({ ok: true });
    });
  });

  router.get('/me', requireAuth, (req: Request, res: Response) => {
    const ctx = getCtx(req);
    res.json({ user: serializeUser(req.user!, ctx.config) });
  });

  return router;
}
