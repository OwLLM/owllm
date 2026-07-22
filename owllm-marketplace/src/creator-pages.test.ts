import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type Database from 'better-sqlite3';
import type { Express } from 'express';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase, createUserStore, type UserStore } from './db.js';
import { createListingStore, createListingsSchema, type ListingStore } from './listings.js';

type Agent = ReturnType<typeof request.agent>;

interface Fixture {
  app: Express;
  db: Database.Database;
  store: UserStore;
  listings: ListingStore;
  tmpDir: string;
}

function buildFixture(): Fixture {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'owllm-marketplace-creator-pages-'));
  process.env.DATABASE_PATH = join(tempDirectory, 'test.db');
  process.env.GITHUB_CLIENT_ID = 'test-client-id';
  process.env.GITHUB_CLIENT_SECRET = 'test-client-secret';
  process.env.SESSION_SECRET = 'test-session-secret-must-be-at-least-32-characters-long';
  process.env.NODE_ENV = 'test';
  process.env.PORT = '0';
  process.env.ADMIN_GITHUB_IDS = '99';

  const config = loadConfig();
  const db = createDatabase(config);
  createListingsSchema(db);
  const store = createUserStore(db);
  const listings = createListingStore(db);
  const app = createApp({ config, store, listings, db });
  return { app, db, store, listings, tmpDir: tempDirectory };
}

function mockGitHub(user: { id: number; login: string }, repos: Array<{ owner: string; repo: string; private?: boolean }> = []) {
  global.fetch = vi.fn(async (url: string) => {
    if (url === 'https://github.com/login/oauth/access_token') {
      return new Response(
        JSON.stringify({ access_token: 'gho_mock_token', token_type: 'bearer', scope: 'read:user user:email' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url === 'https://api.github.com/user') {
      return new Response(JSON.stringify({ id: user.id, login: user.login, email: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === 'https://api.github.com/user/emails') {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    const match = url.match(/^https:\/\/api\.github\.com\/repos\/([^/]+)\/([^/]+)$/);
    if (match) {
      const [, owner, repo] = match;
      const found = repos.find((item) => item.owner === owner && item.repo === repo);
      if (!found) return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      return new Response(
        JSON.stringify({ owner: { login: found.owner }, name: found.repo, private: found.private ?? false }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
}

async function startOAuth(agent: Agent, returnTo: string): Promise<string> {
  const response = await agent.get(`/auth/github?return_to=${encodeURIComponent(returnTo)}`).expect(302);
  const location = response.headers.location as string;
  const state = new URL(location).searchParams.get('state');
  if (!state) throw new Error('OAuth state missing');
  return state;
}

async function signIn(agent: Agent, user: { id: number; login: string }, returnTo = '/creators/submit') {
  mockGitHub(user);
  const state = await startOAuth(agent, returnTo);
  return agent.get(`/auth/github/callback?code=mock-code&state=${state}`).expect(302);
}

async function becomeCreator(agent: Agent, returnTo = '/creators/submit') {
  await agent
    .post('/creators/become')
    .set('Accept', 'text/html')
    .type('form')
    .send({ return_to: returnTo })
    .expect(302);
}

function form(overrides: Record<string, string> = {}) {
  return {
    title: 'Creator Flight Deck',
    short_description: 'A concise project summary.',
    full_description: 'Full project setup, use cases, and safety notes.',
    category: 'Agents',
    spdx_license: 'MIT',
    repo_url: 'https://github.com/alice/flight-deck',
    demo_url: 'https://demo.example.com/flight-deck',
    screenshots: 'https://images.example.com/one.png\nhttps://images.example.com/two.png',
    ...overrides,
  };
}

describe('creator self-service pages', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture();
  });

  afterEach(() => {
    fixture.db.close();
    rmSync(fixture.tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('walks a creator from first sign-in through draft, approval, edit re-review, rejection, resubmit, and unpublish', async () => {
    const creator = request.agent(fixture.app);

    const anonymousSubmit = await creator.get('/creators/submit').expect(401);
    expect(anonymousSubmit.text).toContain('Sign in with GitHub');
    expect(anonymousSubmit.text).toContain('/auth/github?return_to=%2Fcreators%2Fsubmit');

    const signedIn = await signIn(creator, { id: 42, login: 'alice' });
    expect(signedIn.headers.location).toBe('/creators/submit');

    const needsCreator = await creator.get('/creators/submit').expect(403);
    expect(needsCreator.text).toContain('Enable creator tools');
    await becomeCreator(creator);

    const submitPage = await creator.get('/creators/submit').expect(200);
    expect(submitPage.text).toContain('<h1>Submit project</h1>');
    expect(submitPage.text).toContain('Save draft');
    expect(submitPage.text).toContain('Submit for review');

    mockGitHub({ id: 42, login: 'alice' }, [{ owner: 'alice', repo: 'flight-deck' }]);
    await creator.post('/creators/submit').type('form').send({ ...form(), intent: 'draft' }).expect(302);
    let [listing] = fixture.listings.listByCreator('42');
    expect(listing.status).toBe('draft');
    const publicWhileDraft = await request(fixture.app).get('/').expect(200);
    expect(publicWhileDraft.text).not.toContain('Creator Flight Deck');

    let mine = await creator.get('/creators/projects').expect(200);
    expect(mine.text).toContain('status-draft');
    expect(mine.text).toContain('Submit for review');

    mockGitHub({ id: 42, login: 'alice' }, [{ owner: 'alice', repo: 'flight-deck' }]);
    await creator.post(`/creators/projects/${listing.id}/submit`).expect(302);
    listing = fixture.listings.findById(listing.id)!;
    expect(listing.status).toBe('pending');
    mine = await creator.get('/creators/projects').expect(200);
    expect(mine.text).toContain('status-pending');
    expect(mine.text).toContain('Not visible in public marketplace queries.');

    const publicWhilePending = await request(fixture.app).get('/').expect(200);
    expect(publicWhilePending.text).not.toContain('Creator Flight Deck');

    const admin = request.agent(fixture.app);
    await signIn(admin, { id: 99, login: 'reviewer' }, '/admin/listings/pending');
    await admin.post(`/admin/listings/${listing.id}/approve`).send({ reason: 'Approved for public launch' }).expect(200);
    listing = fixture.listings.findById(listing.id)!;
    expect(listing.status).toBe('approved');

    const approvedEdit = await creator.get(`/creators/projects/${listing.id}/edit`).expect(200);
    expect(approvedEdit.text).toContain('Editing approved content returns it to review');
    expect(approvedEdit.text).toContain('review_acknowledged');

    mockGitHub({ id: 42, login: 'alice' }, [{ owner: 'alice', repo: 'flight-deck' }]);
    const rejectedSave = await creator
      .post(`/creators/projects/${listing.id}/edit`)
      .type('form')
      .send({ ...form({ title: 'Creator Flight Deck Pro' }), intent: 'submit' })
      .expect(400);
    expect(rejectedSave.text).toContain('Confirm this before saving');
    expect(fixture.listings.findById(listing.id)!.status).toBe('approved');

    mockGitHub({ id: 42, login: 'alice' }, [{ owner: 'alice', repo: 'flight-deck' }]);
    await creator
      .post(`/creators/projects/${listing.id}/edit`)
      .type('form')
      .send({ ...form({ title: 'Creator Flight Deck Pro' }), intent: 'submit', review_acknowledged: 'yes' })
      .expect(302);
    listing = fixture.listings.findById(listing.id)!;
    expect(listing.status).toBe('pending');
    expect(listing.title).toBe('Creator Flight Deck Pro');

    await admin.post(`/admin/listings/${listing.id}/reject`).send({ reason: 'Screenshots need current UI' }).expect(200);
    const rejectedMine = await creator.get('/creators/projects').expect(200);
    expect(rejectedMine.text).toContain('status-rejected');
    expect(rejectedMine.text).toContain('Screenshots need current UI');

    mockGitHub({ id: 42, login: 'alice' }, [{ owner: 'alice', repo: 'flight-deck' }]);
    await creator
      .post(`/creators/projects/${listing.id}/edit`)
      .type('form')
      .send({ ...form({ title: 'Creator Flight Deck Pro' }), intent: 'submit' })
      .expect(302);
    expect(fixture.listings.findById(listing.id)!.status).toBe('pending');

    await admin.post(`/admin/listings/${listing.id}/approve`).send({ reason: 'Updated screenshots verified' }).expect(200);
    const publicAfterApproval = await request(fixture.app).get('/').expect(200);
    expect(publicAfterApproval.text).toContain('Creator Flight Deck Pro');

    await creator.post(`/creators/projects/${listing.id}/unpublish`).type('form').send({ reason: 'Paused release' }).expect(302);
    expect(fixture.listings.findById(listing.id)!.status).toBe('withdrawn');
    const publicAfterUnpublish = await request(fixture.app).get('/').expect(200);
    expect(publicAfterUnpublish.text).not.toContain('Creator Flight Deck Pro');
  });

  it('passes the submit → approve → anonymous browse smoke test with working GitHub and demo links', async () => {
    const creator = request.agent(fixture.app);
    await signIn(creator, { id: 42, login: 'alice' }, '/creators/submit');
    await becomeCreator(creator);

    mockGitHub({ id: 42, login: 'alice' }, [{ owner: 'alice', repo: 'flight-deck' }]);
    await creator.post('/creators/submit').type('form').send({ ...form(), intent: 'submit' }).expect(302);
    const [listing] = fixture.listings.listByCreator('42');
    expect(listing.status).toBe('pending');

    // A pending listing is absent from anonymous browse and its share page 404s.
    const browseBefore = await request(fixture.app).get('/').expect(200);
    expect(browseBefore.text).not.toContain('Creator Flight Deck');
    await request(fixture.app).get(`/projects/${listing.slug}`).expect(404);

    // Admin approves through the real moderation endpoint.
    const admin = request.agent(fixture.app);
    await signIn(admin, { id: 99, login: 'reviewer' }, '/admin/listings/pending');
    await admin.post(`/admin/listings/${listing.id}/approve`).send({ reason: 'Launch approved' }).expect(200);
    expect(fixture.listings.findById(listing.id)!.status).toBe('approved');

    // Anonymous browse now lists it, without issuing a session cookie.
    const browse = await request(fixture.app).get('/').expect(200);
    expect(browse.headers['set-cookie']).toBeUndefined();
    expect(browse.text).toContain('Creator Flight Deck');

    // The public share page exposes working, safe GitHub source + live demo links.
    const detail = await request(fixture.app).get(`/projects/${listing.slug}`).expect(200);
    expect(detail.text).toContain('href="https://github.com/alice/flight-deck"');
    expect(detail.text).toContain('View source repository');
    expect(detail.text).toContain('href="https://demo.example.com/flight-deck"');
    expect(detail.text).toContain('Open live demo');
    expect(detail.text).toContain('rel="noopener noreferrer external"');
  });

  it('renders responsive creator layouts for desktop and mobile widths', async () => {
    fixture.store.create('42', 'alice', null);
    fixture.store.setCreator('42', true);
    fixture.listings.createDraft(
      {
        title: 'Responsive Project',
        short_description: 'Responsive summary',
        full_description: 'Responsive full description',
        category: 'Agents',
        spdx_license: 'MIT',
        repo_url: 'https://github.com/alice/responsive-project',
        demo_url: 'https://demo.example.com/responsive-project',
        screenshots: ['https://images.example.com/responsive.png'],
      },
      '42',
    );

    const css = await request(fixture.app).get('/marketplace.css').expect(200);
    expect(css.text).toContain('.creator-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))');
    expect(css.text).toContain('@media(max-width:760px)');
    expect(css.text).toContain('.creator-grid,.creator-two{grid-template-columns:1fr}');

    const desktop = request.agent(fixture.app);
    await signIn(desktop, { id: 42, login: 'alice' }, '/creators/projects');
    let page = await desktop.get('/creators/projects').set('Viewport-Width', '1280').expect(200);
    expect(page.text).toContain('creator-grid');
    expect(page.text).toContain('Responsive Project');

    page = await desktop.get('/creators/projects').set('Viewport-Width', '390').expect(200);
    expect(page.text).toContain('<meta name="viewport" content="width=device-width,initial-scale=1">');
    expect(page.text).toContain('creator-grid');
    expect(page.text).toContain('Responsive Project');
  });
});
