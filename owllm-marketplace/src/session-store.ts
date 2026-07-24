import session from 'express-session';
import type Database from 'better-sqlite3';

const Store = session.Store;

export interface SessionRow {
  sid: string;
  sess: string;
  expire: number;
}

export class SQLiteSessionStore extends Store {
  private db: Database.Database;
  private defaultMaxAgeMs: number;

  constructor(db: Database.Database, defaultMaxAgeMs: number) {
    super();
    this.db = db;
    this.defaultMaxAgeMs = defaultMaxAgeMs;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expire INTEGER NOT NULL
      )
    `);
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire)');
  }

  get(sid: string, callback: (err?: any, session?: session.SessionData | null) => void): void {
    try {
      const row = this.db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expire > ?').get(sid, Date.now()) as
        | SessionRow
        | undefined;
      if (!row) return callback(null, null);
      return callback(null, JSON.parse(row.sess));
    } catch (err) {
      return callback(err);
    }
  }

  set(
    sid: string,
    sess: session.SessionData,
    callback?: (err?: any) => void,
  ): void {
    try {
      const expire = this.computeExpire(sess);
      this.db
        .prepare(
          'INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire',
        )
        .run(sid, JSON.stringify(sess), expire);
      if (callback) callback(null);
    } catch (err) {
      if (callback) callback(err);
    }
  }

  destroy(sid: string, callback?: (err?: any) => void): void {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      if (callback) callback(null);
    } catch (err) {
      if (callback) callback(err);
    }
  }

  touch(sid: string, sess: session.SessionData, callback?: (err?: any) => void): void {
    try {
      const expire = this.computeExpire(sess);
      this.db.prepare('UPDATE sessions SET expire = ? WHERE sid = ?').run(expire, sid);
      if (callback) callback(null);
    } catch (err) {
      if (callback) callback(err);
    }
  }

  private computeExpire(sess: session.SessionData): number {
    if (sess.cookie?.maxAge) {
      return Date.now() + sess.cookie.maxAge;
    }
    if (sess.cookie?.expires) {
      const expires = typeof sess.cookie.expires === 'string' ? new Date(sess.cookie.expires) : sess.cookie.expires;
      return expires.getTime();
    }
    return Date.now() + this.defaultMaxAgeMs;
  }
}
