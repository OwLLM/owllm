import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth, requireCreator, getCtx } from './middleware.js';
import { serializeUser } from './serialize.js';
import {
  validateListingInput,
  verifyRepoOwnership,
  type Listing,
  type ListingInput,
  type ModerationHistoryEntry,
} from './listings.js';
import type { User } from './db.js';

export function createCreatorsRouter(): Router {
  const router = Router();

  router.post('/become', requireAuth, (req: Request, res: Response) => {
    const ctx = getCtx(req);
    const user = ctx.store.setCreator(req.user!.github_id, true);
    const returnTo = typeof req.body.return_to === 'string' ? req.body.return_to : '';
    if (acceptsHtml(req) && isSafeReturnPath(returnTo)) {
      res.redirect(returnTo);
      return;
    }
    res.json({ ok: true, user: serializeUser(user, ctx.config) });
  });

  router.get('/profile', requireAuth, requireCreator, (req: Request, res: Response) => {
    const ctx = getCtx(req);
    res.json({ user: serializeUser(req.user!, ctx.config) });
  });

  router.get('/submit', creatorPageUser, (req: Request, res: Response) => {
    const page = ensureCreatorPage(req, res, '/creators/submit');
    if (!page) return;
    sendCreatorHtml(res, renderSubmitPage({ user: page.user }));
  });

  router.post('/submit', creatorPageUser, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = ensureCreatorPage(req, res, '/creators/submit');
      if (!page) return;
      const result = await saveListingFromForm(req, page.user.github_id);
      if (!result.ok) {
        sendCreatorHtml(
          res.status(result.status),
          renderSubmitPage({ user: page.user, error: result.error, values: formValues(req.body) }),
        );
        return;
      }
      res.redirect(`/creators/projects?created=${result.listing.id}`);
    } catch (err) {
      next(err);
    }
  });

  router.get('/projects', creatorPageUser, (req: Request, res: Response) => {
    const page = ensureCreatorPage(req, res, '/creators/projects');
    if (!page) return;
    const ctx = getCtx(req);
    const listings = ctx.listings.listByCreator(page.user.github_id);
    sendCreatorHtml(res, renderProjectsPage({ user: page.user, listings, histories: historiesFor(req, listings) }));
  });

  router.get('/projects/:id/edit', creatorPageUser, (req: Request, res: Response) => {
    const page = ensureCreatorPage(req, res, '/creators/projects');
    if (!page) return;
    const listing = ownListing(req, res, page.user);
    if (!listing) return;
    sendCreatorHtml(res, renderEditPage({ user: page.user, listing, history: getCtx(req).listings.getHistory(listing.id) }));
  });

  router.post('/projects/:id/edit', creatorPageUser, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = ensureCreatorPage(req, res, '/creators/projects');
      if (!page) return;
      const listing = ownListing(req, res, page.user);
      if (!listing) return;
      if (listing.status === 'approved' && req.body.review_acknowledged !== 'yes') {
        sendCreatorHtml(
          res.status(400),
          renderEditPage({
            user: page.user,
            listing,
            history: getCtx(req).listings.getHistory(listing.id),
            error: 'Approved projects leave public search and return to review when saved with material changes. Confirm this before saving.',
            values: formValues(req.body),
          }),
        );
        return;
      }

      const result = await updateListingFromForm(req, listing);
      if (!result.ok) {
        sendCreatorHtml(
          res.status(result.status),
          renderEditPage({
            user: page.user,
            listing,
            history: getCtx(req).listings.getHistory(listing.id),
            error: result.error,
            values: formValues(req.body),
          }),
        );
        return;
      }
      res.redirect(`/creators/projects?updated=${result.listing.id}`);
    } catch (err) {
      next(err);
    }
  });

  router.post('/projects/:id/submit', creatorPageUser, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = ensureCreatorPage(req, res, '/creators/projects');
      if (!page) return;
      const listing = ownListing(req, res, page.user);
      if (!listing) return;
      const result = await submitListing(req, listing);
      if (!result.ok) {
        sendCreatorHtml(
          res.status(result.status),
          renderEditPage({
            user: page.user,
            listing,
            history: getCtx(req).listings.getHistory(listing.id),
            error: result.error,
          }),
        );
        return;
      }
      res.redirect(`/creators/projects?submitted=${result.listing.id}`);
    } catch (err) {
      next(err);
    }
  });

  router.post('/projects/:id/unpublish', creatorPageUser, (req: Request, res: Response, next: NextFunction) => {
    try {
      const page = ensureCreatorPage(req, res, '/creators/projects');
      if (!page) return;
      const listing = ownListing(req, res, page.user);
      if (!listing) return;
      const reason = typeof req.body.reason === 'string' && req.body.reason.trim()
        ? req.body.reason.trim()
        : 'Creator unpublished listing';
      getCtx(req).listings.withdraw(listing.id, page.user.github_id, reason);
      res.redirect(`/creators/projects?unpublished=${listing.id}`);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function creatorPageUser(req: Request, _res: Response, next: NextFunction): void {
  const userId = req.session.userId;
  if (!userId) {
    next();
    return;
  }
  const user = getCtx(req).store.findByGitHubId(userId);
  if (user) req.user = user;
  next();
}

function ensureCreatorPage(req: Request, res: Response, returnTo: string): { user: User } | null {
  if (!req.user) {
    sendCreatorHtml(res.status(401), renderSignInPage(returnTo));
    return null;
  }
  if (!req.user.is_creator) {
    sendCreatorHtml(res.status(403), renderBecomeCreatorPage(req.user, returnTo));
    return null;
  }
  return { user: req.user };
}

function ownListing(req: Request, res: Response, user: User): Listing | null {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    sendCreatorHtml(res.status(400), renderCreatorError('Invalid project id'));
    return null;
  }
  const listing = getCtx(req).listings.findById(id);
  if (!listing || listing.creator_github_id !== user.github_id) {
    sendCreatorHtml(res.status(404), renderCreatorError('Project not found'));
    return null;
  }
  return listing;
}

async function saveListingFromForm(
  req: Request,
  creatorGitHubId: string,
): Promise<{ ok: true; listing: Listing } | { ok: false; status: number; error: string }> {
  const validation = validateListingInput(formValues(req.body));
  if (!validation.ok) return { ok: false, status: 400, error: validation.error };
  const existing = getCtx(req).listings.findByRepoUrl(validation.input.repo_url);
  if (existing) return { ok: false, status: 409, error: 'A project already exists for this repository.' };
  const ownership = await verifyRepoOwnership(validation.input.repo_url, req.user!.github_login);
  if (!ownership.ok) return { ok: false, status: 400, error: ownership.error };
  const listing = req.body.intent === 'submit'
    ? getCtx(req).listings.create(validation.input, creatorGitHubId)
    : getCtx(req).listings.createDraft(validation.input, creatorGitHubId);
  return { ok: true, listing };
}

async function updateListingFromForm(
  req: Request,
  listing: Listing,
): Promise<{ ok: true; listing: Listing } | { ok: false; status: number; error: string }> {
  if (listing.status === 'withdrawn') {
    return { ok: false, status: 400, error: 'Withdrawn projects cannot be edited.' };
  }
  const validation = validateListingInput(formValues(req.body));
  if (!validation.ok) return { ok: false, status: 400, error: validation.error };
  const existing = getCtx(req).listings.findByRepoUrl(validation.input.repo_url);
  if (existing && existing.id !== listing.id) {
    return { ok: false, status: 409, error: 'A project already exists for this repository.' };
  }
  const ownership = await verifyRepoOwnership(validation.input.repo_url, req.user!.github_login);
  if (!ownership.ok) return { ok: false, status: 400, error: ownership.error };
  const updated = getCtx(req).listings.update(listing.id, validation.input, req.user!.github_id);
  if (req.body.intent === 'submit' && updated.status === 'draft') {
    return submitListing(req, updated);
  }
  return { ok: true, listing: updated };
}

async function submitListing(
  req: Request,
  listing: Listing,
): Promise<{ ok: true; listing: Listing } | { ok: false; status: number; error: string }> {
  if (listing.status === 'withdrawn') {
    return { ok: false, status: 400, error: 'Withdrawn projects cannot be submitted.' };
  }
  const input: ListingInput = {
    title: listing.title,
    short_description: listing.short_description,
    full_description: listing.full_description,
    category: listing.category,
    spdx_license: listing.spdx_license,
    repo_url: listing.repo_url,
    demo_url: listing.demo_url ?? undefined,
    screenshots: parseScreenshotJson(listing),
  };
  const ownership = await verifyRepoOwnership(input.repo_url, req.user!.github_login);
  if (!ownership.ok) return { ok: false, status: 400, error: ownership.error };
  return { ok: true, listing: getCtx(req).listings.submit(listing.id, req.user!.github_id) };
}

function formValues(body: unknown): ListingInput {
  const b = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  return {
    title: stringField(b.title),
    short_description: stringField(b.short_description),
    full_description: stringField(b.full_description),
    category: stringField(b.category),
    spdx_license: stringField(b.spdx_license),
    repo_url: stringField(b.repo_url),
    demo_url: stringField(b.demo_url),
    screenshots: stringField(b.screenshots).split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
  };
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseScreenshotJson(listing: Listing): string[] {
  try {
    const parsed = JSON.parse(listing.screenshots);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function historiesFor(req: Request, listings: Listing[]): Map<number, ModerationHistoryEntry[]> {
  return new Map(listings.map((listing) => [listing.id, getCtx(req).listings.getHistory(listing.id)]));
}

function latestReason(history: ModerationHistoryEntry[], action: string): string | null {
  return history.find((entry) => entry.action === action)?.note ?? null;
}

function renderSignInPage(returnTo: string): string {
  return creatorShell({
    title: 'Sign in - OWLLM Marketplace',
    body: `<main class="creator-main creator-narrow"><p class="eyebrow">Creator self-service</p><h1>Sign in to submit projects</h1><p class="creator-muted">Creators use a dedicated marketplace GitHub sign-in. Desktop GitHub tokens are never read or transferred.</p><a class="action primary" href="/auth/github?return_to=${encodeURIComponent(returnTo)}">Sign in with GitHub</a></main>`,
  });
}

function renderBecomeCreatorPage(user: User, returnTo: string): string {
  return creatorShell({
    title: 'Enable creator account - OWLLM Marketplace',
    body: `<main class="creator-main creator-narrow"><p class="eyebrow">Signed in as ${escapeHtml(user.github_login)}</p><h1>Enable creator tools</h1><p class="creator-muted">Creator tools let you draft, submit, edit, resubmit, and unpublish projects tied to repositories you control.</p><form method="post" action="/creators/become"><input type="hidden" name="return_to" value="${escapeAttr(returnTo)}"><button class="action primary" type="submit">Enable creator account</button></form></main>`,
  });
}

function renderSubmitPage(input: { user: User; error?: string; values?: ListingInput }): string {
  return creatorShell({
    title: 'Submit project - OWLLM Marketplace',
    body: `<main class="creator-main"><div class="creator-heading"><div><p class="eyebrow">Signed in as ${escapeHtml(input.user.github_login)}</p><h1>Submit project</h1><p class="creator-muted">Save a validated draft first, or submit directly to human review.</p></div><a class="creator-link" href="/creators/projects">My projects</a></div>${renderError(input.error)}${renderListingForm({ action: '/creators/submit', values: input.values, mode: 'create' })}</main>`,
  });
}

function renderProjectsPage(input: {
  user: User;
  listings: Listing[];
  histories: Map<number, ModerationHistoryEntry[]>;
}): string {
  const cards = input.listings.length
    ? input.listings.map((listing) => renderCreatorProjectCard(listing, input.histories.get(listing.id) ?? [])).join('')
    : '<p class="creator-empty">No projects yet. Create a draft from Submit project.</p>';
  return creatorShell({
    title: 'My projects - OWLLM Marketplace',
    body: `<main class="creator-main"><div class="creator-heading"><div><p class="eyebrow">Signed in as ${escapeHtml(input.user.github_login)}</p><h1>My projects</h1><p class="creator-muted">Track review status, fix rejection feedback, resubmit drafts, and unpublish public projects.</p></div><a class="action primary compact" href="/creators/submit">Submit project</a></div><section class="creator-grid" aria-label="Your marketplace projects">${cards}</section></main>`,
  });
}

function renderCreatorProjectCard(listing: Listing, history: ModerationHistoryEntry[]): string {
  const rejection = latestReason(history, 'rejected');
  const publicNote = listing.status === 'approved'
    ? '<p class="creator-good">Public in marketplace search.</p>'
    : '<p class="creator-muted">Not visible in public marketplace queries.</p>';
  const rejectionNote = listing.status === 'rejected' && rejection
    ? `<p class="creator-rejection"><strong>Rejection reason:</strong> ${escapeHtml(rejection)}</p>`
    : '';
  const submitButton = listing.status === 'draft' || listing.status === 'rejected'
    ? `<form method="post" action="/creators/projects/${listing.id}/submit"><button type="submit">Submit for review</button></form>`
    : '';
  const unpublishButton = listing.status === 'approved'
    ? `<form method="post" action="/creators/projects/${listing.id}/unpublish"><input type="hidden" name="reason" value="Creator unpublished from self-service"><button class="danger" type="submit">Unpublish</button></form>`
    : '';
  return `<article class="creator-card"><div class="creator-card-top"><h2>${escapeHtml(listing.title)}</h2><span class="status-pill status-${listing.status}">${escapeHtml(listing.status)}</span></div><p>${escapeHtml(listing.short_description)}</p>${publicNote}${rejectionNote}<dl><div><dt>Repository</dt><dd>${escapeHtml(listing.repo_url)}</dd></div><div><dt>Category</dt><dd>${escapeHtml(listing.category)}</dd></div></dl><div class="creator-actions"><a href="/creators/projects/${listing.id}/edit">Edit</a>${submitButton}${unpublishButton}</div></article>`;
}

function renderEditPage(input: {
  user: User;
  listing: Listing;
  history: ModerationHistoryEntry[];
  error?: string;
  values?: ListingInput;
}): string {
  const rejection = latestReason(input.history, 'rejected');
  const rejectionNote = input.listing.status === 'rejected' && rejection
    ? `<aside class="creator-warning"><strong>Rejection reason</strong><p>${escapeHtml(rejection)}</p></aside>`
    : '';
  const reviewWarning = input.listing.status === 'approved'
    ? '<aside class="creator-warning"><strong>Editing approved content returns it to review</strong><p>Saving material changes immediately removes this project from public results until an admin approves it again.</p></aside>'
    : '';
  return creatorShell({
    title: `Edit ${input.listing.title} - OWLLM Marketplace`,
    body: `<main class="creator-main"><div class="creator-heading"><div><p class="eyebrow">Status: ${escapeHtml(input.listing.status)}</p><h1>Edit project</h1><p class="creator-muted">Update details, resubmit rejected work, or save a draft without entering review.</p></div><a class="creator-link" href="/creators/projects">My projects</a></div>${renderError(input.error)}${rejectionNote}${reviewWarning}${renderListingForm({ action: `/creators/projects/${input.listing.id}/edit`, values: input.values ?? listingToInput(input.listing), mode: 'edit', approved: input.listing.status === 'approved', status: input.listing.status })}</main>`,
  });
}

function renderListingForm(input: {
  action: string;
  values?: ListingInput;
  mode: 'create' | 'edit';
  approved?: boolean;
  status?: Listing['status'];
}): string {
  const values = input.values ?? emptyInput();
  const submitLabel = input.mode === 'create' ? 'Submit for review' : 'Save and submit';
  const draftLabel = input.mode === 'create' ? 'Save draft' : 'Save changes';
  const approvedWarning = input.approved
    ? '<label class="creator-check"><input type="checkbox" name="review_acknowledged" value="yes" required><span>I understand that saving material changes returns this approved project to pending review and removes it from public results.</span></label>'
    : '';
  const draftButton = input.status === 'approved'
    ? ''
    : `<button type="submit" name="intent" value="draft">${draftLabel}</button>`;
  return `<form class="creator-form" method="post" action="${escapeAttr(input.action)}">
    <label><span>Title</span><input name="title" value="${escapeAttr(values.title)}" maxlength="120" required></label>
    <label><span>Short description</span><input name="short_description" value="${escapeAttr(values.short_description)}" maxlength="300" required></label>
    <label><span>Full description</span><textarea name="full_description" maxlength="5000" required>${escapeHtml(values.full_description)}</textarea></label>
    <div class="creator-two"><label><span>Category</span><input name="category" value="${escapeAttr(values.category)}" maxlength="60" required></label><label><span>SPDX license</span><input name="spdx_license" value="${escapeAttr(values.spdx_license)}" maxlength="60" required></label></div>
    <label><span>Public GitHub repository URL</span><input name="repo_url" type="url" value="${escapeAttr(values.repo_url)}" placeholder="https://github.com/owner/repo" required></label>
    <label><span>Demo URL optional, HTTPS only</span><input name="demo_url" type="url" value="${escapeAttr(values.demo_url ?? '')}" placeholder="https://example.com/demo"></label>
    <label><span>Screenshot URLs, one HTTPS URL per line, max 6</span><textarea name="screenshots">${escapeHtml(values.screenshots.join('\n'))}</textarea></label>
    ${approvedWarning}
    <div class="creator-form-actions">${draftButton}<button class="primary-button" type="submit" name="intent" value="submit">${submitLabel}</button></div>
  </form>`;
}

function renderCreatorError(message: string): string {
  return creatorShell({
    title: 'Creator project unavailable - OWLLM Marketplace',
    body: `<main class="creator-main creator-narrow"><h1>${escapeHtml(message)}</h1><a class="creator-link" href="/creators/projects">Back to my projects</a></main>`,
  });
}

function renderError(error: string | undefined): string {
  return error ? `<p class="creator-error" role="alert">${escapeHtml(error)}</p>` : '';
}

function listingToInput(listing: Listing): ListingInput {
  return {
    title: listing.title,
    short_description: listing.short_description,
    full_description: listing.full_description,
    category: listing.category,
    spdx_license: listing.spdx_license,
    repo_url: listing.repo_url,
    demo_url: listing.demo_url ?? '',
    screenshots: parseScreenshotJson(listing),
  };
}

function emptyInput(): ListingInput {
  return {
    title: '',
    short_description: '',
    full_description: '',
    category: '',
    spdx_license: '',
    repo_url: '',
    demo_url: '',
    screenshots: [],
  };
}

function creatorShell(input: { title: string; body: string }): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(input.title)}</title><link rel="stylesheet" href="/marketplace.css"></head><body><header class="site-header"><a class="brand" href="/" aria-label="OWLLM Marketplace home"><span class="brand-mark" aria-hidden="true">O</span><span>OWLLM <strong>Marketplace</strong></span></a><nav class="creator-nav"><a href="/creators/submit">Submit project</a><a href="/creators/projects">My projects</a></nav></header>${input.body}<footer><span>OWLLM Marketplace</span><span>Creator self-service</span></footer></body></html>`;
}

function sendCreatorHtml(res: Response, html: string): void {
  res
    .type('html')
    .set('Cache-Control', 'no-store')
    .set('Content-Security-Policy', "default-src 'self'; img-src https: data:; style-src 'self'; script-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'")
    .set('Referrer-Policy', 'no-referrer')
    .set('X-Content-Type-Options', 'nosniff')
    .set('X-Frame-Options', 'DENY')
    .send(html);
}

function acceptsHtml(req: Request): boolean {
  return req.accepts(['html', 'json']) === 'html';
}

function isSafeReturnPath(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !value.includes('\\');
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;');
}
