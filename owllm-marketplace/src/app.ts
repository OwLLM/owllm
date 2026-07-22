import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import session from 'express-session';
import type { AppContext } from './context.js';
import { SQLiteSessionStore } from './session-store.js';
import { createAuthRouter } from './auth.js';
import { createCreatorsRouter } from './creators.js';
import { createAdminRouter } from './admin.js';
import {
  createListingsRouter,
  createCreatorListingsRouter,
  createAdminListingsRouter,
} from './listings.js';
import { createPublicMarketplaceRouter } from './public.js';
import './types.js';

export function createApp(ctx: AppContext): Express {
  const app = express();
  if (ctx.config.trustProxy !== undefined) {
    app.set('trust proxy', ctx.config.trustProxy);
  }
  app.use(express.json());
  app.use(
    session({
      store: new SQLiteSessionStore(ctx.db, ctx.config.sessionMaxAgeMs),
      secret: ctx.config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      name: 'owllm.sid',
      cookie: {
        secure: ctx.config.nodeEnv === 'production',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: ctx.config.sessionMaxAgeMs,
      },
    }),
  );
  app.locals.ctx = ctx;

  app.use('/auth', createAuthRouter());
  app.use('/creators', createCreatorsRouter());
  app.use('/creators/listings', createCreatorListingsRouter());
  app.use('/listings', createListingsRouter());
  app.use('/admin', createAdminRouter());
  app.use('/admin/listings', createAdminListingsRouter());
  app.use('/', createPublicMarketplaceRouter());

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true });
  });

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  });

  return app;
}
