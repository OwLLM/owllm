import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type Database from 'better-sqlite3';
import type { Express } from 'express';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase, createUserStore, type UserStore } from './db.js';
import {
  createListingStore,
  createListingsSchema,
  type Listing,
  type ListingInput,
  type ListingStatus,
  type ListingStore,
} from './listings.js';

interface Fixture {
  app: Express;
  db: Database.Database;
  store: UserStore;
  listings: ListingStore;
  tmpDir: string;
}

function buildFixture(): Fixture {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'owllm-marketplace-public-'));
  process.env.DATABASE_PATH = join(tempDirectory, 'test.db');
  process.env.GITHUB_CLIENT_ID = 'test-client-id';
  process.env.GITHUB_CLIENT_SECRET = 'test-client-secret';
  process.env.SESSION_SECRET = 'test-session-secret-must-be-at-least-32-characters-long';
  process.env.NODE_ENV = 'test';
  process.env.PORT = '0';
  process.env.PUBLIC_BASE_URL = 'https://marketplace.example.com';

  const config = loadConfig();
  const db = createDatabase(config);
  createListingsSchema(db);
  const store = createUserStore(db);
  const listings = createListingStore(db);
  const app = createApp({ config, store, listings, db });
  return { app, db, store, listings, tmpDir: tempDirectory };
}

function listingInput(name: string, overrides: Partial<ListingInput> = {}): ListingInput {
  const slug = name.toLocaleLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    title: name,
    short_description: `${name} short description`,
    full_description: `${name} full description with setup notes and examples.`,
    category: 'Agents',
    spdx_license: 'MIT',
    repo_url: `https://github.com/alice/${slug}`,
    demo_url: `https://demo.example.com/${slug}`,
    screenshots: [`https://images.example.com/${slug}.png`],
    ...overrides,
  };
}

function createListing(
  fixture: Fixture,
  name: string,
  status: ListingStatus,
  overrides: Partial<ListingInput> = {},
): Listing {
  const listing = fixture.listings.create(listingInput(name, overrides), '42');
  return status === 'pending'
    ? listing
    : fixture.listings.setStatus(listing.id, status, '99', `${status} for test`);
}

describe('anonymous public marketplace', () => {
  let fixture: Fixture;

  beforeEach(() => {
    fixture = buildFixture();
    fixture.store.create('42', 'alice', null);
    fixture.store.create('99', 'reviewer', null);
  });

  afterEach(() => {
    fixture.db.close();
    rmSync(fixture.tmpDir, { recursive: true, force: true });
    delete process.env.PUBLIC_BASE_URL;
  });

  it('renders approved cards and server-side search/category filters without an account', async () => {
    createListing(fixture, 'Agent Architect', 'approved');
    createListing(fixture, 'Data Curator', 'approved', { category: 'Research' });
    createListing(fixture, 'Secret Pending Project', 'pending');

    const browse = await request(fixture.app).get('/').expect(200);
    expect(browse.headers['set-cookie']).toBeUndefined();
    expect(browse.text).toContain('Browse anonymously');
    expect(browse.text).toContain('Agent Architect');
    expect(browse.text).toContain('Data Curator');
    expect(browse.text).not.toContain('Secret Pending Project');
    expect(browse.text).toContain('id="project-search"');
    expect(browse.text).toContain('id="project-category"');

    const searched = await request(fixture.app).get('/?q=architect').expect(200);
    expect(searched.text).toContain('Agent Architect');
    expect(searched.text).toMatch(/<article class="project-card"[^>]*data-category="research"[^>]* hidden>/);

    const categorized = await request(fixture.app).get('/?category=Research').expect(200);
    expect(categorized.text).toContain('Data Curator');
    expect(categorized.text).toMatch(/<article class="project-card"[^>]*data-category="agents"[^>]* hidden>/);
  });

  it('renders an indexable share page with all public project fields and safe outbound links', async () => {
    const listing = createListing(fixture, 'Agent Architect', 'approved');

    const detail = await request(fixture.app).get(`/projects/${listing.slug}`).expect(200);
    expect(detail.headers['set-cookie']).toBeUndefined();
    expect(detail.headers['x-robots-tag']).toBe('index, follow');
    expect(detail.headers['content-security-policy']).toContain("script-src 'self'");
    expect(detail.text).toContain('<meta name="robots" content="index,follow,max-image-preview:large">');
    expect(detail.text).toContain(`https://marketplace.example.com/projects/${listing.slug}`);
    expect(detail.text).toContain('Agent Architect full description');
    expect(detail.text).toContain('alice');
    expect(detail.text).toContain('MIT');
    expect(detail.text).toContain('Agent Architect screenshot 1');
    expect(detail.text).toContain('View source repository');
    expect(detail.text).toContain('Opens GitHub · no download or execution');
    expect(detail.text).toContain('Open live demo');
    expect(detail.text).toContain('External site · nothing is installed');
    expect(detail.text).toContain('rel="noopener noreferrer external"');
    expect(detail.text).not.toContain('onclick=');
    expect(detail.text).not.toContain(' download=');
    expect(detail.text).toContain('"@type":"SoftwareSourceCode"');

    const publicJson = await request(fixture.app).get(`/listings/${listing.slug}`).expect(200);
    expect(publicJson.body.listing.creator).toEqual({
      github_login: 'alice',
      profile_url: 'https://github.com/alice',
    });
  });

  it('omits the demo action when a listing has no demo URL', async () => {
    const listing = createListing(fixture, 'Offline Helper', 'approved', { demo_url: undefined });
    const detail = await request(fixture.app).get(`/projects/${listing.slug}`).expect(200);
    expect(detail.text).not.toContain('Open live demo');
    expect(detail.text).toContain('View source repository');
  });

  it.each(['pending', 'rejected', 'withdrawn'] as const)(
    'returns no public content for a %s listing',
    async (status) => {
      const listing = createListing(fixture, `Private ${status} title`, status);
      const secret = `Private ${status} title`;

      const page = await request(fixture.app).get(`/projects/${listing.slug}`).expect(404);
      expect(page.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.text).not.toContain(secret);
      expect(page.text).not.toContain(listing.repo_url);

      const api = await request(fixture.app).get(`/listings/${listing.slug}`).expect(404);
      expect(api.body).toEqual({ error: 'listing not found' });
      expect(JSON.stringify(api.body)).not.toContain(secret);
    },
  );

  it('includes only approved projects in the sitemap', async () => {
    const approved = createListing(fixture, 'Public Sitemap Project', 'approved');
    const pending = createListing(fixture, 'Pending Sitemap Project', 'pending');
    const rejected = createListing(fixture, 'Rejected Sitemap Project', 'rejected');
    const withdrawn = createListing(fixture, 'Withdrawn Sitemap Project', 'withdrawn');

    const sitemap = await request(fixture.app).get('/sitemap.xml').expect(200);
    expect(sitemap.text).toContain(`/projects/${approved.slug}`);
    expect(sitemap.text).not.toContain(pending.slug);
    expect(sitemap.text).not.toContain(rejected.slug);
    expect(sitemap.text).not.toContain(withdrawn.slug);
  });

  it('escapes stored listing content before rendering HTML and structured data', async () => {
    const listing = createListing(fixture, '<script>alert("owned")</script>', 'approved', {
      short_description: 'Safe <img src=x onerror=alert(1)> text',
    });
    const detail = await request(fixture.app).get(`/projects/${listing.slug}`).expect(200);
    expect(detail.text).not.toContain('<script>alert("owned")</script>');
    expect(detail.text).not.toContain('<img src=x onerror=alert(1)>');
    expect(detail.text).toContain('&lt;script&gt;alert(&quot;owned&quot;)&lt;/script&gt;');
    expect(detail.text).toContain('\\u003cscript>');
  });
});
