import type { User } from './db.js';

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    oauthState?: string;
  }
}

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export {};
