import type { User } from './db.js';

declare module 'express-session' {
  interface SessionData {
    userId?: string;
    oauthState?: string;
    oauthReturnTo?: string;
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
