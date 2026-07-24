import Database from 'better-sqlite3';
import type { Config } from './config.js';

export interface User {
  id: number;
  github_id: string;
  github_login: string;
  email: string | null;
  is_creator: number;
  created_at: string;
  updated_at: string;
}

export interface UserStore {
  findByGitHubId(githubId: string): User | undefined;
  create(githubId: string, login: string, email: string | null): User;
  updateLogin(githubId: string, login: string, email: string | null): User;
  setCreator(githubId: string, isCreator: boolean): User;
  all(): User[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_id TEXT NOT NULL UNIQUE,
  github_login TEXT NOT NULL,
  email TEXT,
  is_creator INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function createDatabase(config: Config): Database.Database {
  const db = new Database(config.databasePath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}

export function createUserStore(db: Database.Database): UserStore {
  return {
    findByGitHubId(githubId: string) {
      const row = db.prepare('SELECT * FROM users WHERE github_id = ?').get(githubId);
      return (row as User | undefined) ?? undefined;
    },
    create(githubId: string, login: string, email: string | null) {
      const result = db
        .prepare('INSERT INTO users (github_id, github_login, email) VALUES (?, ?, ?)')
        .run(githubId, login, email ?? null);
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid) as User | undefined;
      if (!user) throw new Error('Failed to create user');
      return user;
    },
    updateLogin(githubId: string, login: string, email: string | null) {
      db.prepare('UPDATE users SET github_login = ?, email = ?, updated_at = datetime(\'now\') WHERE github_id = ?').run(
        login,
        email ?? null,
        githubId,
      );
      const user = db.prepare('SELECT * FROM users WHERE github_id = ?').get(githubId) as User | undefined;
      if (!user) throw new Error('User missing after update');
      return user;
    },
    setCreator(githubId: string, isCreator: boolean) {
      db.prepare('UPDATE users SET is_creator = ?, updated_at = datetime(\'now\') WHERE github_id = ?').run(
        isCreator ? 1 : 0,
        githubId,
      );
      const user = db.prepare('SELECT * FROM users WHERE github_id = ?').get(githubId) as User | undefined;
      if (!user) throw new Error('User missing after creator update');
      return user;
    },
    all() {
      return db.prepare('SELECT * FROM users ORDER BY id').all() as User[];
    },
  };
}
