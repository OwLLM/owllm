import crypto from 'crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import type Database from 'better-sqlite3';
import type { AppContext } from './context.js';
import { requireAuth, requireCreator, requireAdmin, getCtx } from './middleware.js';
import './types.js';

export type ListingStatus = 'draft' | 'pending' | 'approved' | 'rejected' | 'withdrawn';

export interface Listing {
  id: number;
  creator_github_id: string;
  slug: string;
  title: string;
  short_description: string;
  full_description: string;
  category: string;
  spdx_license: string;
  repo_url: string;
  demo_url: string | null;
  screenshots: string;
  status: ListingStatus;
  created_at: string;
  updated_at: string;
}

export interface ListingInput {
  title: string;
  short_description: string;
  full_description: string;
  category: string;
  spdx_license: string;
  repo_url: string;
  demo_url?: string;
  screenshots: string[];
}

export interface ModerationHistoryEntry {
  id: number;
  listing_id: number;
  actor_github_id: string;
  action: string;
  note: string | null;
  created_at: string;
}

export interface ListingStore {
  create(input: ListingInput, creatorGitHubId: string): Listing;
  createDraft(input: ListingInput, creatorGitHubId: string): Listing;
  update(id: number, input: ListingInput, modifierGitHubId: string): Listing;
  submit(id: number, actorGitHubId: string): Listing;
  setStatus(id: number, status: ListingStatus, actorGitHubId: string, note: string | null): Listing;
  withdraw(id: number, actorGitHubId: string, note: string | null): Listing;
  findById(id: number): Listing | undefined;
  findBySlug(slug: string): Listing | undefined;
  findByRepoUrl(repoUrl: string): Listing | undefined;
  listPublic(): Listing[];
  listPending(): Listing[];
  listByCreator(githubId: string): Listing[];
  recordHistory(listingId: number, actorGitHubId: string, action: string, note: string | null): void;
  getHistory(listingId: number): ModerationHistoryEntry[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_github_id TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  short_description TEXT NOT NULL,
  full_description TEXT NOT NULL,
  category TEXT NOT NULL,
  spdx_license TEXT NOT NULL,
  repo_url TEXT NOT NULL UNIQUE,
  demo_url TEXT,
  screenshots TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_creator ON listings(creator_github_id);

CREATE TABLE IF NOT EXISTS listing_moderation_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL,
  actor_github_id TEXT NOT NULL,
  action TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
);
`;

const MAX_TITLE = 120;
const MAX_SHORT_DESC = 300;
const MAX_FULL_DESC = 5000;
const MAX_CATEGORY = 60;
const MAX_SPDX = 60;
const MAX_SCREENSHOTS = 6;
const MAX_DEMO_URL = 500;
const MAX_SCREENSHOT_URL = 500;

export function createListingsSchema(db: Database.Database): void {
  db.exec(SCHEMA);
}

export function createListingStore(db: Database.Database): ListingStore {
  const insert = db.prepare<
    [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string,
      string | null,
      string,
      string,
    ],
    Listing
  >(
    `INSERT INTO listings (
      creator_github_id, slug, title, short_description, full_description,
      category, spdx_license, repo_url, demo_url, screenshots, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    RETURNING *`,
  );

  const updateStmt = db.prepare<
    [
      string,
      string,
      string,
      string,
      string,
      string,
      string | null,
      string,
      string,
      number,
    ],
    Listing
  >(
    `UPDATE listings SET
      title = ?, short_description = ?, full_description = ?, category = ?,
      spdx_license = ?, repo_url = ?, demo_url = ?, screenshots = ?, status = ?,
      updated_at = datetime('now')
    WHERE id = ?
    RETURNING *`,
  );

  const setStatusStmt = db.prepare<
    [string, number],
    Listing
  >(
    `UPDATE listings SET
      status = ?, updated_at = datetime('now')
    WHERE id = ?
    RETURNING *`,
  );

  const findById = db.prepare<number, Listing>('SELECT * FROM listings WHERE id = ?');
  const findBySlug = db.prepare<string, Listing>('SELECT * FROM listings WHERE slug = ?');
  const findByRepoUrl = db.prepare<string, Listing>('SELECT * FROM listings WHERE repo_url = ?');
  const listPublic = db.prepare<[], Listing>("SELECT * FROM listings WHERE status = 'approved' ORDER BY created_at DESC");
  const listPending = db.prepare<[], Listing>("SELECT * FROM listings WHERE status = 'pending' ORDER BY created_at ASC");
  const listByCreator = db.prepare<string, Listing>('SELECT * FROM listings WHERE creator_github_id = ? ORDER BY created_at DESC');
  const insertHistory = db.prepare(
    'INSERT INTO listing_moderation_history (listing_id, actor_github_id, action, note) VALUES (?, ?, ?, ?)',
  );
  const getHistory = db.prepare<number, ModerationHistoryEntry>(
    'SELECT * FROM listing_moderation_history WHERE listing_id = ? ORDER BY created_at DESC, id DESC',
  );

  return {
    create(input, creatorGitHubId) {
      return insertListing(input, creatorGitHubId, 'pending', 'submitted', 'Listing submitted for review');
    },

    createDraft(input, creatorGitHubId) {
      return insertListing(input, creatorGitHubId, 'draft', 'draft_created', 'Draft created');
    },

    update(id, input, modifierGitHubId) {
      const existing = findById.get(id);
      if (!existing) throw new Error('Listing not found');

      const demoUrl = normalizeOptionalUrl(input.demo_url);
      const screenshotsJson = JSON.stringify(input.screenshots);

      const materialChanged = hasMaterialChange(existing, {
        title: input.title,
        short_description: input.short_description,
        full_description: input.full_description,
        category: input.category,
        spdx_license: input.spdx_license,
        repo_url: input.repo_url,
        demo_url: demoUrl,
        screenshots: screenshotsJson,
      });

      let nextStatus: ListingStatus = existing.status;
      if (existing.status === 'approved' && materialChanged) {
        nextStatus = 'pending';
      } else if (existing.status === 'rejected') {
        nextStatus = 'pending';
      } else if (existing.status === 'withdrawn') {
        throw new Error('withdrawn listings cannot be edited');
      }

      const row = updateStmt.get(
        input.title,
        input.short_description,
        input.full_description,
        input.category,
        input.spdx_license,
        input.repo_url,
        demoUrl,
        screenshotsJson,
        nextStatus,
        id,
      );
      if (!row) throw new Error('Listing not found');

      if (nextStatus !== existing.status) {
        insertHistory.run(row.id, modifierGitHubId, 'status_changed', `Returned to ${nextStatus} after edit`);
      }
      insertHistory.run(row.id, modifierGitHubId, 'updated', 'Listing updated');
      return row;
    },

    submit(id, actorGitHubId) {
      const existing = findById.get(id);
      if (!existing) throw new Error('Listing not found');
      if (existing.status === 'approved') throw new Error('approved listings are already public');
      if (existing.status === 'withdrawn') throw new Error('withdrawn listings cannot be submitted');
      if (existing.status === 'pending') return existing;
      const row = setStatusStmt.get('pending', id);
      if (!row) throw new Error('Listing not found');
      insertHistory.run(row.id, actorGitHubId, 'submitted', 'Listing submitted for review');
      return row;
    },

    setStatus(id, status, actorGitHubId, note) {
      const existing = findById.get(id);
      if (!existing) throw new Error('Listing not found');
      if (existing.status === status) {
        return existing;
      }
      const row = setStatusStmt.get(status, id);
      if (!row) throw new Error('Listing not found');
      insertHistory.run(row.id, actorGitHubId, status, note ?? null);
      return row;
    },

    withdraw(id, actorGitHubId, note) {
      return this.setStatus(id, 'withdrawn', actorGitHubId, note ?? 'Creator withdrew listing');
    },

    findById(id) {
      return findById.get(id) ?? undefined;
    },

    findBySlug(slug) {
      return findBySlug.get(slug) ?? undefined;
    },

    findByRepoUrl(repoUrl) {
      return findByRepoUrl.get(repoUrl) ?? undefined;
    },

    listPublic() {
      return listPublic.all();
    },

    listPending() {
      return listPending.all();
    },

    listByCreator(githubId) {
      return listByCreator.all(githubId);
    },

    recordHistory(listingId, actorGitHubId, action, note) {
      insertHistory.run(listingId, actorGitHubId, action, note);
    },

    getHistory(listingId) {
      return getHistory.all(listingId);
    },
  };

  function insertListing(
    input: ListingInput,
    creatorGitHubId: string,
    status: ListingStatus,
    action: string,
    note: string,
  ): Listing {
    const slug = generateSlug(input.title);
    const demoUrl = normalizeOptionalUrl(input.demo_url);
    const screenshotsJson = JSON.stringify(input.screenshots);
    const row = insert.get(
      creatorGitHubId,
      slug,
      input.title,
      input.short_description,
      input.full_description,
      input.category,
      input.spdx_license,
      input.repo_url,
      demoUrl,
      screenshotsJson,
      status,
    );
    if (!row) throw new Error('Failed to create listing');
    insertHistory.run(row.id, creatorGitHubId, action, note);
    return row;
  }
}

function hasMaterialChange(
  existing: Listing,
  next: {
    title: string;
    short_description: string;
    full_description: string;
    category: string;
    spdx_license: string;
    repo_url: string;
    demo_url: string | null;
    screenshots: string;
  },
): boolean {
  return (
    existing.title !== next.title ||
    existing.short_description !== next.short_description ||
    existing.full_description !== next.full_description ||
    existing.category !== next.category ||
    existing.spdx_license !== next.spdx_license ||
    existing.repo_url !== next.repo_url ||
    existing.demo_url !== next.demo_url ||
    existing.screenshots !== next.screenshots
  );
}

function generateSlug(title: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  const suffix = crypto.randomBytes(4).toString('hex');
  return `${base || 'listing'}-${suffix}`;
}

function normalizeOptionalUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

export type ValidationResult =
  | { ok: true; input: Required<Pick<ListingInput, 'demo_url'>> & Omit<ListingInput, 'demo_url'> }
  | { ok: false; error: string };

export function validateListingInput(body: unknown): ValidationResult {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'invalid body' };
  }

  const b = body as Record<string, unknown>;

  const title = requiredString(b.title, 'title', 1, MAX_TITLE);
  if (title.error) return title.error;

  const shortDesc = requiredString(b.short_description, 'short_description', 1, MAX_SHORT_DESC);
  if (shortDesc.error) return shortDesc.error;

  const fullDesc = requiredString(b.full_description, 'full_description', 1, MAX_FULL_DESC);
  if (fullDesc.error) return fullDesc.error;

  const category = requiredString(b.category, 'category', 1, MAX_CATEGORY);
  if (category.error) return category.error;

  const spdx = requiredString(b.spdx_license, 'spdx_license', 1, MAX_SPDX);
  if (spdx.error) return spdx.error;

  const repoUrl = requiredString(b.repo_url, 'repo_url', 1, 500);
  if (repoUrl.error) return repoUrl.error;

  const repoParse = parseGitHubRepoUrl(repoUrl.value);
  if (!repoParse.ok) return { ok: false, error: 'repo_url must be a public https://github.com/{owner}/{repo} URL' };

  let demoUrl: string | undefined;
  if (b.demo_url !== undefined && b.demo_url !== null && b.demo_url !== '') {
    const demo = requiredString(b.demo_url, 'demo_url', 1, MAX_DEMO_URL);
    if (demo.error) return demo.error;
    if (!isHttpsUrl(demo.value)) {
      return { ok: false, error: 'demo_url must use HTTPS' };
    }
    demoUrl = demo.value;
  }

  const screenshots = parseScreenshots(b.screenshots);
  if (!screenshots.ok) return { ok: false, error: screenshots.error };

  return {
    ok: true,
    input: {
      title: title.value,
      short_description: shortDesc.value,
      full_description: fullDesc.value,
      category: category.value,
      spdx_license: spdx.value,
      repo_url: repoUrl.value,
      demo_url: demoUrl ?? '',
      screenshots: screenshots.value,
    },
  };
}

function requiredString(
  value: unknown,
  field: string,
  min: number,
  max: number,
): { value: string; error?: undefined } | { error: { ok: false; error: string } } {
  if (typeof value !== 'string') {
    return { error: { ok: false, error: `${field} must be a string` } };
  }
  const trimmed = value.trim();
  if (trimmed.length < min) {
    return { error: { ok: false, error: `${field} is too short` } };
  }
  if (trimmed.length > max) {
    return { error: { ok: false, error: `${field} is too long` } };
  }
  return { value: trimmed };
}

function parseScreenshots(value: unknown): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) {
    return { ok: false, error: 'screenshots must be an array' };
  }
  if (value.length > MAX_SCREENSHOTS) {
    return { ok: false, error: `at most ${MAX_SCREENSHOTS} screenshots are allowed` };
  }
  const urls: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) {
      return { ok: false, error: 'each screenshot must be a non-empty URL' };
    }
    const url = entry.trim();
    if (url.length > MAX_SCREENSHOT_URL) {
      return { ok: false, error: 'screenshot URL is too long' };
    }
    if (!isHttpsUrl(url)) {
      return { ok: false, error: 'screenshot URLs must use HTTPS' };
    }
    urls.push(url);
  }
  return { ok: true, value: urls };
}

export function isHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface ParsedRepo {
  owner: string;
  repo: string;
}

export function parseGitHubRepoUrl(url: string): { ok: true; repo: ParsedRepo } | { ok: false } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false };
  }
  if (parsed.protocol !== 'https:') return { ok: false };
  if (parsed.hostname !== 'github.com') return { ok: false };
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return { ok: false };
  const [owner, repo] = parts;
  if (!owner || !repo) return { ok: false };
  return { ok: true, repo: { owner, repo } };
}

export async function verifyRepoOwnership(
  repoUrl: string,
  ownerLogin: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = parseGitHubRepoUrl(repoUrl);
  if (!parsed.ok) return { ok: false, error: 'invalid GitHub repository URL' };

  const { owner, repo } = parsed.repo;
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  try {
    const response = await fetch(apiUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'owllm-marketplace',
      },
    });

    if (response.status === 404) {
      return { ok: false, error: 'repository not found or private' };
    }
    if (response.status === 403) {
      return { ok: false, error: 'repository not accessible' };
    }
    if (!response.ok) {
      return { ok: false, error: `GitHub API error: ${response.status}` };
    }

    const data = (await response.json()) as { owner?: { login?: string }; private?: boolean };
    if (data.private) {
      return { ok: false, error: 'repository is private' };
    }
    if (data.owner?.login?.toLowerCase() !== ownerLogin.toLowerCase()) {
      return { ok: false, error: 'repository is not owned by the signed-in creator' };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, error: 'failed to reach GitHub API' };
  }
}

export function serializeListing(listing: Listing) {
  return {
    id: listing.id,
    slug: listing.slug,
    title: listing.title,
    short_description: listing.short_description,
    full_description: listing.full_description,
    category: listing.category,
    spdx_license: listing.spdx_license,
    repo_url: listing.repo_url,
    demo_url: listing.demo_url,
    screenshots: JSON.parse(listing.screenshots) as string[],
    status: listing.status,
    creator_github_id: listing.creator_github_id,
    created_at: listing.created_at,
    updated_at: listing.updated_at,
  };
}

function serializePublicListing(listing: Listing, creatorLogin: string) {
  return {
    ...serializeListing(listing),
    creator: {
      github_login: creatorLogin,
      profile_url: `https://github.com/${encodeURIComponent(creatorLogin)}`,
    },
  };
}

export function createListingsRouter(): Router {
  const router = Router();

  router.get('/', (req: Request, res: Response) => {
    const ctx = getCtx(req);
    const listings = ctx.listings.listPublic().flatMap((listing) => {
      const creator = ctx.store.findByGitHubId(listing.creator_github_id);
      return creator ? [serializePublicListing(listing, creator.github_login)] : [];
    });
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300').json({ listings });
  });

  router.get('/:slug', (req: Request, res: Response) => {
    const ctx = getCtx(req);
    const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
    const listing = ctx.listings.findBySlug(slug);
    if (!listing || listing.status !== 'approved') {
      res.status(404).json({ error: 'listing not found' });
      return;
    }
    const creator = ctx.store.findByGitHubId(listing.creator_github_id);
    if (!creator) {
      res.status(404).json({ error: 'listing not found' });
      return;
    }
    res
      .set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
      .json({ listing: serializePublicListing(listing, creator.github_login) });
  });

  return router;
}

export function createCreatorListingsRouter(): Router {
  const router = Router();

  router.post('/', requireAuth, requireCreator, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = getCtx(req);
      const validated = validateListingInput(req.body);
      if (!validated.ok) {
        res.status(400).json({ error: validated.error });
        return;
      }

      const { input } = validated;
      const existing = ctx.listings.findByRepoUrl(input.repo_url);
      if (existing) {
        res.status(409).json({ error: 'a listing already exists for this repository' });
        return;
      }

      const ownership = await verifyRepoOwnership(input.repo_url, req.user!.github_login);
      if (!ownership.ok) {
        res.status(400).json({ error: ownership.error });
        return;
      }

      const listing = ctx.listings.create(input, req.user!.github_id);
      res.status(201).json({ listing: serializeListing(listing) });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/:id', requireAuth, requireCreator, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = getCtx(req);
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ error: 'invalid listing id' });
        return;
      }

      const listing = ctx.listings.findById(id);
      if (!listing) {
        res.status(404).json({ error: 'listing not found' });
        return;
      }
      if (listing.creator_github_id !== req.user!.github_id) {
        res.status(403).json({ error: 'not authorized to update this listing' });
        return;
      }
      if (listing.status === 'withdrawn') {
        res.status(400).json({ error: 'withdrawn listings cannot be edited' });
        return;
      }

      const validated = validateListingInput(req.body);
      if (!validated.ok) {
        res.status(400).json({ error: validated.error });
        return;
      }

      const { input } = validated;
      const existing = ctx.listings.findByRepoUrl(input.repo_url);
      if (existing && existing.id !== id) {
        res.status(409).json({ error: 'a listing already exists for this repository' });
        return;
      }

      const ownership = await verifyRepoOwnership(input.repo_url, req.user!.github_login);
      if (!ownership.ok) {
        res.status(400).json({ error: ownership.error });
        return;
      }

      const updated = ctx.listings.update(id, input, req.user!.github_id);
      res.json({ listing: serializeListing(updated) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/:id/withdraw', requireAuth, requireCreator, (req: Request, res: Response, next: NextFunction) => {
    try {
      const ctx = getCtx(req);
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ error: 'invalid listing id' });
        return;
      }

      const listing = ctx.listings.findById(id);
      if (!listing) {
        res.status(404).json({ error: 'listing not found' });
        return;
      }
      if (listing.creator_github_id !== req.user!.github_id) {
        res.status(403).json({ error: 'not authorized to withdraw this listing' });
        return;
      }

      const note = typeof req.body.reason === 'string' ? req.body.reason : null;
      const withdrawn = ctx.listings.withdraw(id, req.user!.github_id, note);
      res.json({ listing: serializeListing(withdrawn) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/my', requireAuth, requireCreator, (req: Request, res: Response) => {
    const ctx = getCtx(req);
    const listings = ctx.listings.listByCreator(req.user!.github_id);
    res.json({ listings: listings.map(serializeListing) });
  });

  return router;
}

export function createAdminListingsRouter(): Router {
  const router = Router();

  router.get('/pending', requireAuth, requireAdmin, (req: Request, res: Response) => {
    const ctx = getCtx(req);
    const listings = ctx.listings.listPending();
    res.json({ listings: listings.map(serializeListing) });
  });

  router.post(
    '/:id/approve',
    requireAuth,
    requireAdmin,
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const ctx = getCtx(req);
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) {
          res.status(400).json({ error: 'invalid listing id' });
          return;
        }

        const listing = ctx.listings.findById(id);
        if (!listing) {
          res.status(404).json({ error: 'listing not found' });
          return;
        }

        const note = typeof req.body.reason === 'string' ? req.body.reason : null;
        const approved = ctx.listings.setStatus(id, 'approved', req.user!.github_id, note);
        res.json({ listing: serializeListing(approved) });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/:id/reject',
    requireAuth,
    requireAdmin,
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const ctx = getCtx(req);
        const id = Number(req.params.id);
        if (!Number.isFinite(id) || id <= 0) {
          res.status(400).json({ error: 'invalid listing id' });
          return;
        }

        const listing = ctx.listings.findById(id);
        if (!listing) {
          res.status(404).json({ error: 'listing not found' });
          return;
        }

        const reason = req.body.reason;
        if (typeof reason !== 'string' || !reason.trim()) {
          res.status(400).json({ error: 'rejection reason is required' });
          return;
        }

        const rejected = ctx.listings.setStatus(id, 'rejected', req.user!.github_id, reason.trim());
        res.json({ listing: serializeListing(rejected) });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
