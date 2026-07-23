import 'dotenv/config';
import { loadConfig } from './config.js';
import { createDatabase, createUserStore } from './db.js';
import { createListingStore, createListingsSchema } from './listings.js';
import { createApp } from './app.js';

const config = loadConfig();
const db = createDatabase(config);
createListingsSchema(db);
const store = createUserStore(db);
const listings = createListingStore(db);
const app = createApp({ config, store, listings, db });

const server = app.listen(config.port, () => {
  console.log(`owllm-marketplace listening on http://localhost:${config.port}`);
});

function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down gracefully`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
