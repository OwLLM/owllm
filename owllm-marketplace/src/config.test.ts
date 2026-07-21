import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from './config.js';

describe('config', () => {
  let tmpDir: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'owllm-marketplace-config-'));
    originalEnv = { ...process.env };

    process.env.DATABASE_PATH = join(tmpDir, 'test.db');
    process.env.GITHUB_CLIENT_ID = 'test-client-id';
    process.env.GITHUB_CLIENT_SECRET = 'test-client-secret';
    process.env.SESSION_SECRET = 'a'.repeat(32);
    process.env.NODE_ENV = 'test';
    process.env.PORT = '0';
    process.env.SESSION_MAX_AGE_MS = '86400000';
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('loads valid config with defaults', () => {
    const config = loadConfig();
    expect(config.nodeEnv).toBe('test');
    expect(config.githubClientId).toBe('test-client-id');
    expect(config.sessionMaxAgeMs).toBe(86_400_000);
    expect(config.adminGitHubIds).toEqual(new Set());
  });

  it('parses admin allowlist and trust proxy settings', () => {
    process.env.ADMIN_GITHUB_IDS = ' 123, 456 , 123 ';
    process.env.TRUST_PROXY = '1';

    const config = loadConfig();
    expect(config.adminGitHubIds).toEqual(new Set(['123', '456']));
    expect(config.trustProxy).toBe(1);
  });

  it('throws when SESSION_SECRET is too short', () => {
    process.env.SESSION_SECRET = 'short';
    expect(() => loadConfig()).toThrow('SESSION_SECRET must be at least 32 characters long');
  });

  it('throws when a required environment variable is missing', () => {
    delete process.env.GITHUB_CLIENT_SECRET;
    expect(() => loadConfig()).toThrow('Missing required environment variable: GITHUB_CLIENT_SECRET');
  });
});
