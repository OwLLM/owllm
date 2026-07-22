import 'dotenv/config';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  githubClientId: string;
  githubClientSecret: string;
  sessionSecret: string;
  sessionMaxAgeMs: number;
  databasePath: string;
  adminGitHubIds: Set<string>;
  publicBaseUrl?: string;
  trustProxy?: boolean | number;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(`Invalid millisecond value: ${value}`);
  }
  return n;
}

function parseTrustProxy(value: string | undefined): boolean | number | undefined {
  if (!value) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  const n = Number(value);
  if (!Number.isNaN(n)) return n;
  return true;
}

function parsePublicBaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid PUBLIC_BASE_URL: ${value}`);
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost') {
    throw new Error('PUBLIC_BASE_URL must use HTTPS');
  }
  return parsed.toString().replace(/\/$/, '');
}

export function loadConfig(): Config {
  const databasePath = requireEnv('DATABASE_PATH');
  const dir = dirname(databasePath);
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  return {
    nodeEnv: (process.env.NODE_ENV as Config['nodeEnv']) ?? 'development',
    port: Number(process.env.PORT) || 3000,
    githubClientId: requireEnv('GITHUB_CLIENT_ID'),
    githubClientSecret: requireEnv('GITHUB_CLIENT_SECRET'),
    sessionSecret: (() => {
      const secret = requireEnv('SESSION_SECRET');
      if (secret.length < 32) {
        throw new Error('SESSION_SECRET must be at least 32 characters long');
      }
      return secret;
    })(),
    sessionMaxAgeMs: parseMs(process.env.SESSION_MAX_AGE_MS, 24 * 60 * 60 * 1000),
    databasePath,
    publicBaseUrl: parsePublicBaseUrl(process.env.PUBLIC_BASE_URL),
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    adminGitHubIds: new Set(
      (process.env.ADMIN_GITHUB_IDS ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  };
}
