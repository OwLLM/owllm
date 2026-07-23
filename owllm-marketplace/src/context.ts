import type { Config } from './config.js';
import type { UserStore } from './db.js';
import type { ListingStore } from './listings.js';
import type Database from 'better-sqlite3';

export interface AppContext {
  config: Config;
  store: UserStore;
  listings: ListingStore;
  db: Database.Database;
}
