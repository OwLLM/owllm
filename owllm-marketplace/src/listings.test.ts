import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
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

type Agent = ReturnType<typeof request.agent>;

interface TestFixture {
  app: Express;
  config: Config;
  db: Database.Database;
  store: UserStore;
  listings: ListingStore;
  tmpDir: string;
}

interface MockRepo {
  owner: string;
  repo: string;
  private?: boolean;
  status?: number;
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

function mockGitHubAuth(user: { id: number; login: string; email?: string | null }) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === 'https://github.com/login/oauth/access_token') {
      return new Response(
        JSON.stringify({
          access_token: 'gho_mock_token',
          token_type: 'bearer',
          scope: 'read:user user:email',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url === 'https://api.github.com/user') {
      return new Response(JSON.stringify(user), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === 'https://api.github.com/user/emails') {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function mockGitHubRepos(repos: MockRepo[]) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === 'https://github.com/login/oauth/access_token') {
      return new Response(
        JSON.stringify({ access_token: 'gho_mock_token', token_type: 'bearer', scope: 'read:user user:email' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url === 'https://api.github.com/user/emails') {
      return new Response(JSON.stringify([]), { status: 200 });
    }

    const match = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)$/);
    if (match) {
      const [, owner, repo] = match;
      const found = repos.find((r) => r.owner === owner && r.repo === repo);
      if (!found) {
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      }
      if (found.status === 403) {
        return new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 });
      }
      return new Response(
        JSON.stringify({ owner: { login: found.owner }, name: found.repo, private: found.private ?? false }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
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

async function signIn(agent: Agent, user: { id: number; login: string; email?: string | null }) {
  mockGitHubAuth(user);
  const state = await startOAuth(agent);
  const res = await agent.get(`/auth/github/callback?code=mock-code&state=${state}`).redirects(1).expect(200);
  return res;
}

async function becomeCreator(agent: Agent) {
  await agent.post('/creators/become').expect(200);
}

function validInput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    title: 'My OwLLM Skill',
    short_description: 'A short description.',
    full_description: 'A much longer full description of the skill.',
    category: 'agents',
    spdx_license: 'MIT',
    repo_url: 'https://github.com/alice/my-skill',
    demo_url: 'https://example.com/demo',
    screenshots: ['https://example.com/shot1.png', 'https://example.com/shot2.png'],
    ...overrides,
  };
}

describe('listing submission boundary', () => {
  let fixture!: TestFixture;

  beforeEach(() => {
    fixture = buildFixture({ adminIds: '99' });
  });

  afterEach(() => {
    fixture.db.close();
    rmSync(fixture.tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('rejects creation when unauthenticated', async () => {
    const agent = request.agent(fixture.app);
    await agent.post('/creators/listings').send(validInput()).expect(401);
  });

  it('rejects creation when not a creator', async () => {
    const agent = request.agent(fixture.app);
    await signIn(agent, { id: 42, login: 'alice' });
    await agent.post('/creators/listings').send(validInput()).expect(403);
  });

  it('rejects invalid repository URL scheme', async () => {
    const agent = request.agent(fixture.app);
    await signIn(agent, { id: 42, login: 'alice' });
    await becomeCreator(agent);

    const res = await agent
      .post('/creators/listings')
      .send(validInput({ repo_url: 'http://github.com/alice/my-skill' }))
      .expect(400);
    expect(res.body.error).toMatch(/github.com/);
  });

  it('rejects unsafe demo URL', async () => {
    const agent = request.agent(fixture.app);
    await signIn(agent, { id: 42, login: 'alice' });
    await becomeCreator(agent);

    mockGitHubRepos([{ owner: 'alice', repo: 'my-skill' }]);
    const res = await agent
      .post('/creators/listings')
      .send(validInput({ demo_url: 'ftp://example.com/demo' }))
      .expect(400);
    expect(res.body.error).toMatch(/HTTPS/);
  });

  it('rejects unsafe screenshot URLs', async () => {
    const agent = request.agent(fixture.app);
    await signIn(agent, { id: 42, login: 'alice' });
    await becomeCreator(agent);

    mockGitHubRepos([{ owner: 'alice', repo: 'my-skill' }]);
    const res = await agent
      .post('/creators/listings')
      .send(validInput({ screenshots: ['http://example.com/shot.png'] }))
      .expect(400);
    expect(res.body.error).toMatch(/HTTPS/);
  });

  it('rejects too many screenshots', async () => {
    const agent = request.agent(fixture.app);
    await signIn(agent, { id: 42, login: 'alice' });
    await becomeCreator(agent);

    mockGitHubRepos([{ owner: 'alice', repo: 'my-skill' }]);
    const res = await agent
      .post('/creators/listings')
      .send(validInput({ screenshots: Array(7).fill('https://example.com/shot.png') }))
      .expect(400);
    expect(res.body.error).toMatch(/at most/);
  });

  it('rejects a repository that does not exist or is private', async () => {
    const agent = request.agent(fixture.app);
    await signIn(agent, { id: 42, login: 'alice' });
    await becomeCreator(agent);

    mockGitHubRepos([]);
    const res = await agent.post('/creators/listings').send(validInput()).expect(400);
    expect(res.body.error).toMatch(/private|not found|not accessible/i);
  });

  it('rejects an explicitly private repository', async () => {
    const agent = request.agent(fixture.app);
    await signIn(agent, { id: 42, login: 'alice' });
    await becomeCreator(agent);

    mockGitHubRepos([{ owner: 'alice', repo: 'my-skill', private: true }]);
    const res = await agent.post('/creators/listings').send(validInput()).expect(400);
    expect(res.body.error).toMatch(/private/);
  });

  it('rejects a repository not owned by the signed-in creator', async () => {
    const agent = request.agent(fixture.app);
    await signIn(agent, { id: 42, login: 'alice' });
    await becomeCreator(agent);

    mockGitHubRepos([{ owner: 'bob', repo: 'my-skill' }]);
    const res = await agent
      .post('/creators/listings')
      .send(validInput({ repo_url: 'https://github.com/bob/my-skill' }))
      .expect(400);
    expect(res.body.error).toMatch(/not owned/);
  });

  it('creates a valid listing in pending status and hides it from public queries', async () => {
    const agent = request.agent(fixture.app);
    await signIn(agent, { id: 42, login: 'alice' });
    await becomeCreator(agent);

    mockGitHubRepos([{ owner: 'alice', repo: 'my-skill' }]);
    const res = await agent.post('/creators/listings').send(validInput()).expect(201);
    expect(res.body.listing.status).toBe('pending');
    expect(res.body.listing.title).toBe('My OwLLM Skill');

    const publicList = await request.agent(fixture.app).get('/listings').expect(200);
    expect(publicList.body.listings).toHaveLength(0);

    const publicDetail = await request
      .agent(fixture.app)
      .get(`/listings/${res.body.listing.slug}`)
      .expect(404);
    expect(publicDetail.body.error).toBe('listing not found');
  });

  it('records moderation history on create', async () => {
    const agent = request.agent(fixture.app);
    await signIn(agent, { id: 42, login: 'alice' });
    await becomeCreator(agent);

    mockGitHubRepos([{ owner: 'alice', repo: 'my-skill' }]);
    const res = await agent.post('/creators/listings').send(validInput()).expect(201);

    const history = fixture.listings.getHistory(res.body.listing.id);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      actor_github_id: '42',
      action: 'submitted',
    });
  });

  it('rejects duplicate repository listings', async () => {
    const agent = request.agent(fixture.app);
    await signIn(agent, { id: 42, login: 'alice' });
    await becomeCreator(agent);

    mockGitHubRepos([{ owner: 'alice', repo: 'my-skill' }]);
    await agent.post('/creators/listings').send(validInput()).expect(201);

    const res = await agent
      .post('/creators/listings')
      .send(validInput({ title: 'Different Title' }))
      .expect(409);
    expect(res.body.error).toMatch(/already exists/);
  });

  it('allows creators to update their own listings and records history', async () => {
    const agent = request.agent(fixture.app);
    await signIn(agent, { id: 42, login: 'alice' });
    await becomeCreator(agent);

    mockGitHubRepos([{ owner: 'alice', repo: 'my-skill' }]);
    const created = await agent.post('/creators/listings').send(validInput()).expect(201);
    const id = created.body.listing.id;

    mockGitHubRepos([{ owner: 'alice', repo: 'my-skill' }]);
    const updated = await agent
      .patch(`/creators/listings/${id}`)
      .send(validInput({ title: 'Updated Title' }))
      .expect(200);
    expect(updated.body.listing.title).toBe('Updated Title');
    expect(updated.body.listing.status).toBe('pending');

    const history = fixture.listings.getHistory(id);
    expect(history).toHaveLength(2);
    expect(history[0].action).toBe('updated');
    expect(history[1].action).toBe('submitted');
  });

  it('rejects updates from another creator', async () => {
    const agent = request.agent(fixture.app);
    await signIn(agent, { id: 42, login: 'alice' });
    await becomeCreator(agent);

    mockGitHubRepos([{ owner: 'alice', repo: 'my-skill' }]);
    const created = await agent.post('/creators/listings').send(validInput()).expect(201);

    const mallory = request.agent(fixture.app);
    await signIn(mallory, { id: 99, login: 'mallory' });
    await becomeCreator(mallory);

    await mallory.patch(`/creators/listings/${created.body.listing.id}`).send(validInput()).expect(403);
  });

  it('rejects update when repository is unowned', async () => {
    const agent = request.agent(fixture.app);
    await signIn(agent, { id: 42, login: 'alice' });
    await becomeCreator(agent);

    mockGitHubRepos([{ owner: 'alice', repo: 'my-skill' }]);
    const created = await agent.post('/creators/listings').send(validInput()).expect(201);

    mockGitHubRepos([{ owner: 'bob', repo: 'my-skill' }]);
    const res = await agent
      .patch(`/creators/listings/${created.body.listing.id}`)
      .send(validInput({ repo_url: 'https://github.com/bob/my-skill' }))
      .expect(400);
    expect(res.body.error).toMatch(/not owned/);
  });

  it('rejects update that duplicates another listing repo', async () => {
    const agent = request.agent(fixture.app);
    await signIn(agent, { id: 42, login: 'alice' });
    await becomeCreator(agent);

    mockGitHubRepos([
      { owner: 'alice', repo: 'my-skill' },
      { owner: 'alice', repo: 'other-skill' },
    ]);
    const first = await agent
      .post('/creators/listings')
      .send(validInput({ repo_url: 'https://github.com/alice/my-skill' }))
      .expect(201);
    const second = await agent
      .post('/creators/listings')
      .send(validInput({ repo_url: 'https://github.com/alice/other-skill', title: 'Other' }))
      .expect(201);

    const res = await agent
      .patch(`/creators/listings/${second.body.listing.id}`)
      .send(validInput({ repo_url: 'https://github.com/alice/my-skill' }))
      .expect(409);
    expect(res.body.error).toMatch(/already exists/);
  });

  it('lists pending listings in the admin review queue', async () => {
    const creator = request.agent(fixture.app);
    await signIn(creator, { id: 42, login: 'alice' });
    await becomeCreator(creator);

    mockGitHubRepos([{ owner: 'alice', repo: 'my-skill' }]);
    await creator.post('/creators/listings').send(validInput()).expect(201);

    const admin = request.agent(fixture.app);
    await signIn(admin, { id: 99, login: 'admin' });

    const res = await admin.get('/admin/listings/pending').expect(200);
    expect(res.body.listings).toHaveLength(1);
    expect(res.body.listings[0].status).toBe('pending');
  });

  it('allows admins to approve a listing with a reason and records history', async () => {
    const creator = request.agent(fixture.app);
    await signIn(creator, { id: 42, login: 'alice' });
    await becomeCreator(creator);

    mockGitHubRepos([{ owner: 'alice', repo: 'my-skill' }]);
    const created = await creator.post('/creators/listings').send(validInput()).expect(201);

    const admin = request.agent(fixture.app);
    await signIn(admin, { id: 99, login: 'admin' });

    const res = await admin
      .post(`/admin/listings/${created.body.listing.id}/approve`)
      .send({ reason: 'Looks good' })
      .expect(200);
    expect(res.body.listing.status).toBe('approved');

    const history = fixture.listings.getHistory(created.body.listing.id);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      actor_github_id: '99',
      action: 'approved',
      note: 'Looks good',
    });
  });

  it('allows admins to reject a listing with a reason and records history', async () => {
    const creator = request.agent(fixture.app);
    await signIn(creator, { id: 42, login: 'alice' });
    await becomeCreator(creator);

    mockGitHubRepos([{ owner: 'alice', repo: 'my-skill' }]);
    const created = await creator.post('/creators/listings').send(validInput()).expect(201);

    const admin = request.agent(fixture.app);
    await signIn(admin, { id: 99, login: 'admin' });

    const res = await admin
      .post(`/admin/listings/${created.body.listing.id}/reject`)
      .send({ reason: 'Missing documentation' })
      .expect(200);
    expect(res.body.listing.status).toBe('rejected');

    const history = fixture.listings.getHistory(created.body.listing.id);
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({
      actor_github_id: '99',
      action: 'rejected',
      note: 'Missing documentation',
    });
  });

  it('requires a reason when rejecting', async () => {
    const creator = request.agent(fixture.app);
    await signIn(creator, { id: 42, login: 'alice' });
    await becomeCreator(creator);

    mockGitHubRepos([{ owner: 'alice', repo: 'my-skill' }]);
    const created = await creator.post('/creators/listings').send(validInput()).expect(201);

    const admin = request.agent(fixture.app);
    await signIn(admin, { id: 99, login: 'admin' });

    const res = await admin
      .post(`/admin/listings/${created.body.listing.id}/reject`)
      .send({})
      .expect(400);
    expect(res.body.error).toMatch(/reason is required/);
  });

  it('prevents creators from approving their own listings', async () => {
    const creator = request.agent(fixture.app);
    await signIn(creator, { id: 42, login: 'alice' });
    await becomeCreator(creator);

    mockGitHubRepos([{ owner: 'alice', repo: 'my-skill' }]);
    const created = await creator.post('/creators/listings').send(validInput()).expect(201);

    await creator.post(`/admin/listings/${created.body.listing.id}/approve`).expect(403);
  });

  it('returns an approved listing to pending after a material edit', async () => {
    const agent = request.agent(fixture.app);
    await signIn(agent, { id: 42, login: 'alice' });
    await becomeCreator(agent);

    mockGitHubRepos([{ owner: 'alice', repo: 'my-skill' }]);
    const created = await agent.post('/creators/listings').send(validInput()).expect(201);
    fixture.listings.setStatus(created.body.listing.id, 'approved', '99', 'Pre-approved for test');

    mockGitHubRepos([{ owner: 'alice', repo: 'my-skill' }]);
    const updated = await agent
      .patch(`/creators/listings/${created.body.listing.id}`)
      .send(validInput({ title: 'Updated Title' }))
      .expect(200);
    expect(updated.body.listing.status).toBe('pending');

    const publicList = await request.agent(fixture.app).get('/listings').expect(200);
    expect(publicList.body.listings).toHaveLength(0);

    const history = fixture.listings.getHistory(created.body.listing.id);
    expect(history[0].action).toBe('updated');
    expect(history[1].action).toBe('status_changed');
  });

  it('keeps an approved listing approved when no material fields change', async () => {
    const agent = request.agent(fixture.app);
    await signIn(agent, { id: 42, login: 'alice' });
    await becomeCreator(agent);

    mockGitHubRepos([{ owner: 'alice', repo: 'my-skill' }]);
    const created = await agent.post('/creators/listings').send(validInput()).expect(201);
    fixture.listings.setStatus(created.body.listing.id, 'approved', '99', 'Pre-approved for test');

    mockGitHubRepos([{ owner: 'alice', repo: 'my-skill' }]);
    const updated = await agent
      .patch(`/creators/listings/${created.body.listing.id}`)
      .send(validInput())
      .expect(200);
    expect(updated.body.listing.status).toBe('approved');

    const publicList = await request.agent(fixture.app).get('/listings').expect(200);
    expect(publicList.body.listings).toHaveLength(1);
  });

  it('lets a creator withdraw their own listing and hides it from public results', async () => {
    const creator = request.agent(fixture.app);
    await signIn(creator, { id: 42, login: 'alice' });
    await becomeCreator(creator);

    mockGitHubRepos([{ owner: 'alice', repo: 'my-skill' }]);
    const created = await creator.post('/creators/listings').send(validInput()).expect(201);

    const admin = request.agent(fixture.app);
    await signIn(admin, { id: 99, login: 'admin' });
    await admin.post(`/admin/listings/${created.body.listing.id}/approve`).expect(200);

    const withdrawn = await creator
      .post(`/creators/listings/${created.body.listing.id}/withdraw`)
      .send({ reason: 'No longer maintained' })
      .expect(200);
    expect(withdrawn.body.listing.status).toBe('withdrawn');

    const publicList = await request.agent(fixture.app).get('/listings').expect(200);
    expect(publicList.body.listings).toHaveLength(0);

    const history = fixture.listings.getHistory(created.body.listing.id);
    expect(history[0]).toMatchObject({
      actor_github_id: '42',
      action: 'withdrawn',
      note: 'No longer maintained',
    });
  });

  it('prevents creators from withdrawing another creators listing', async () => {
    const agent = request.agent(fixture.app);
    await signIn(agent, { id: 42, login: 'alice' });
    await becomeCreator(agent);

    mockGitHubRepos([{ owner: 'alice', repo: 'my-skill' }]);
    const created = await agent.post('/creators/listings').send(validInput()).expect(201);

    const mallory = request.agent(fixture.app);
    await signIn(mallory, { id: 99, login: 'mallory' });
    await becomeCreator(mallory);

    await mallory.post(`/creators/listings/${created.body.listing.id}/withdraw`).expect(403);
  });

  it('prevents editing a withdrawn listing', async () => {
    const agent = request.agent(fixture.app);
    await signIn(agent, { id: 42, login: 'alice' });
    await becomeCreator(agent);

    mockGitHubRepos([{ owner: 'alice', repo: 'my-skill' }]);
    const created = await agent.post('/creators/listings').send(validInput()).expect(201);
    fixture.listings.withdraw(created.body.listing.id, '42', 'test withdrawal');

    mockGitHubRepos([{ owner: 'alice', repo: 'my-skill' }]);
    const res = await agent
      .patch(`/creators/listings/${created.body.listing.id}`)
      .send(validInput({ title: 'Updated Title' }))
      .expect(400);
    expect(res.body.error).toMatch(/withdrawn/);
  });
});
