import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

type Agent = ReturnType<typeof request.agent>;
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadConfig } from './config.js';
import { createDatabase, createUserStore } from './db.js';
import { createListingStore, createListingsSchema } from './listings.js';
import { createApp } from './app.js';
import type { Config } from './config.js';
import type Database from 'better-sqlite3';
import type { Express } from 'express';
import type { UserStore } from './db.js';
import type { ListingStore } from './listings.js';

interface TestFixture {
  app: Express;
  config: Config;
  db: Database.Database;
  store: UserStore;
  listings: ListingStore;
  tmpDir: string;
}

function buildFixture(envOverrides: Record<string, string> = {}): TestFixture {
  const tmpDir = mkdtempSync(join(tmpdir(), 'owllm-marketplace-'));
  process.env.DATABASE_PATH = join(tmpDir, 'test.db');
  process.env.GITHUB_CLIENT_ID = 'test-client-id';
  process.env.GITHUB_CLIENT_SECRET = 'test-client-secret';
  process.env.SESSION_SECRET = 'test-session-secret-must-be-at-least-32-characters-long';
  process.env.NODE_ENV = 'test';
  process.env.PORT = '0';
  process.env.SESSION_MAX_AGE_MS = envOverrides.sessionMaxAgeMs ?? '86400000';
  process.env.ADMIN_GITHUB_IDS = envOverrides.adminIds ?? '';

  const config = loadConfig();
  const db = createDatabase(config);
  createListingsSchema(db);
  const store = createUserStore(db);
  const listings = createListingStore(db);
  const app = createApp({ config, store, listings, db });
  return { app, config, db, store, listings, tmpDir };
}

function mockGitHub(options: {
  token?: string;
  user?: { id: number; login: string; email?: string | null };
  emails?: Array<{ email: string; primary: boolean; verified: boolean }>;
}) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === 'https://github.com/login/oauth/access_token') {
      return new Response(
        JSON.stringify({
          access_token: options.token ?? 'gho_mock_token',
          token_type: 'bearer',
          scope: 'read:user user:email',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url === 'https://api.github.com/user') {
      const user = options.user ?? { id: 1, login: 'testuser', email: 'test@example.com' };
      return new Response(JSON.stringify(user), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === 'https://api.github.com/user/emails') {
      return new Response(JSON.stringify(options.emails ?? []), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

async function startOAuth(agent: Agent): Promise<string> {
  const res = await agent.get('/auth/github').expect(302);
  const location = res.headers.location as string;
  const url = new URL(location);
  const state = url.searchParams.get('state');
  if (!state) throw new Error('Missing OAuth state in redirect');
  return state;
}

async function signIn(
  agent: Agent,
  user: { id: number; login: string; email?: string | null },
) {
  mockGitHub({ user });
  const state = await startOAuth(agent);
  const res = await agent.get(`/auth/github/callback?code=mock-code&state=${state}`).redirects(1).expect(200);
  return res;
}

describe('marketplace auth', () => {
  let fixture!: TestFixture;

  beforeEach(() => {
    fixture = buildFixture();
  });

  afterEach(() => {
    fixture.db.close();
    rmSync(fixture.tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('signs in and returns the authenticated user', async () => {
    const agent = request.agent(fixture.app);
    const res = await signIn(agent, { id: 42, login: 'alice', email: 'alice@example.com' });

    expect(res.body.user).toMatchObject({
      github_id: '42',
      github_login: 'alice',
      email: 'alice@example.com',
      is_creator: false,
      is_admin: false,
    });
  });

  it('rejects callback when state does not match', async () => {
    const agent = request.agent(fixture.app);
    await startOAuth(agent);
    await agent.get('/auth/github/callback?code=mock-code&state=attacker-state').expect(403);
  });

  it('rejects callback when no OAuth flow was started', async () => {
    const agent = request.agent(fixture.app);
    await agent.get('/auth/github/callback?code=mock-code&state=whatever').expect(403);
  });

  it('rejects callback when code or state query params are missing', async () => {
    const agent = request.agent(fixture.app);
    await startOAuth(agent);
    await agent.get('/auth/github/callback?code=mock-code').expect(400);
    await agent.get('/auth/github/callback?state=whatever').expect(400);
  });

  it('signs out and destroys the session', async () => {
    const agent = request.agent(fixture.app);
    await signIn(agent, { id: 42, login: 'alice' });

    const signOutRes = await agent.post('/auth/signout').expect(200);
    expect(signOutRes.headers['set-cookie']?.[0]).toMatch(/owllm\.sid=;/);
    await agent.get('/auth/me').expect(401);
  });

  it('returns 401 for /auth/me when not authenticated', async () => {
    const agent = request.agent(fixture.app);
    await agent.get('/auth/me').expect(401);
  });

  it('returns 401 when the session has expired', async () => {
    const agent = request.agent(fixture.app);
    await signIn(agent, { id: 42, login: 'alice' });

    // Force the server-side session to expire without waiting for real time.
    fixture.db.prepare('UPDATE sessions SET expire = ?').run(Date.now() - 1);

    await agent.get('/auth/me').expect(401);
  });

  it('replays the same state only once', async () => {
    const agent = request.agent(fixture.app);
    mockGitHub({ user: { id: 42, login: 'alice' } });
    const state = await startOAuth(agent);

    await agent.get(`/auth/github/callback?code=mock-code&state=${state}`).redirects(1).expect(200);
    await agent.get(`/auth/github/callback?code=mock-code&state=${state}`).expect(403);
  });
});

describe('creator route guards', () => {
  let fixture!: TestFixture;

  beforeEach(() => {
    fixture = buildFixture();
  });

  afterEach(() => {
    fixture.db.close();
    rmSync(fixture.tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('blocks creator endpoints for normal users', async () => {
    const agent = request.agent(fixture.app);
    await signIn(agent, { id: 42, login: 'bob' });
    await agent.get('/creators/profile').expect(403);
  });

  it('allows creator endpoints after becoming a creator', async () => {
    const agent = request.agent(fixture.app);
    await signIn(agent, { id: 42, login: 'bob' });

    const becomeRes = await agent.post('/creators/become').expect(200);
    expect(becomeRes.body.user.is_creator).toBe(true);

    const profileRes = await agent.get('/creators/profile').expect(200);
    expect(profileRes.body.user.github_id).toBe('42');
  });
});

describe('admin route guards', () => {
  let fixture: TestFixture;

  beforeEach(() => {
    fixture = buildFixture({ adminIds: '99' });
  });

  afterEach(() => {
    fixture.db.close();
    rmSync(fixture.tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('blocks admin endpoints for non-allowlisted users', async () => {
    const agent = request.agent(fixture.app);
    await signIn(agent, { id: 42, login: 'mallory' });
    await agent.get('/admin/users').expect(403);
  });

  it('allows admin endpoints for allowlisted users', async () => {
    const agent = request.agent(fixture.app);
    const res = await signIn(agent, { id: 99, login: 'admin' });
    expect(res.body.user.is_admin).toBe(true);

    const usersRes = await agent.get('/admin/users').expect(200);
    expect(usersRes.body.users).toHaveLength(1);
    expect(usersRes.body.users[0].github_id).toBe('99');
  });
});

describe('account rename', () => {
  let fixture!: TestFixture;

  beforeEach(() => {
    fixture = buildFixture();
  });

  afterEach(() => {
    fixture.db.close();
    rmSync(fixture.tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('updates github_login for the same immutable github_id', async () => {
    const agent = request.agent(fixture.app);
    const first = await signIn(agent, { id: 42, login: 'old-name' });
    expect(first.body.user.github_login).toBe('old-name');

    mockGitHub({ user: { id: 42, login: 'new-name', email: 'new@example.com' } });
    const state = await startOAuth(agent);
    const second = await agent.get(`/auth/github/callback?code=mock-code&state=${state}`).redirects(1).expect(200);

    expect(second.body.user).toMatchObject({
      github_id: '42',
      github_login: 'new-name',
      email: 'new@example.com',
    });

    // Still only one user row because ownership is keyed to github_id.
    const users = fixture.store.all();
    expect(users).toHaveLength(1);
  });
});
