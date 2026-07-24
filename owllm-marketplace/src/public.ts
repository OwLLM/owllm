import { Router, type Request, type Response } from 'express';
import type { AppContext } from './context.js';
import type { Listing } from './listings.js';
import { getCtx } from './middleware.js';

interface PublicListing {
  listing: Listing;
  creatorLogin: string;
}

const CACHE_PUBLIC = 'public, max-age=60, stale-while-revalidate=300';
const CACHE_ASSET = 'public, max-age=3600';

export function createPublicMarketplaceRouter(): Router {
  const router = Router();

  router.get('/marketplace.css', (_req: Request, res: Response) => {
    res.type('text/css').set('Cache-Control', CACHE_ASSET).send(MARKETPLACE_CSS);
  });

  router.get('/marketplace.js', (_req: Request, res: Response) => {
    res.type('application/javascript').set('Cache-Control', CACHE_ASSET).send(MARKETPLACE_JS);
  });

  router.get('/robots.txt', (req: Request, res: Response) => {
    const baseUrl = publicBaseUrl(req, getCtx(req));
    res
      .type('text/plain')
      .set('Cache-Control', CACHE_ASSET)
      .send(`User-agent: *\nAllow: /\nDisallow: /auth/\nDisallow: /admin/\nDisallow: /creators/\nSitemap: ${baseUrl}/sitemap.xml\n`);
  });

  router.get('/sitemap.xml', (req: Request, res: Response) => {
    const ctx = getCtx(req);
    const baseUrl = publicBaseUrl(req, ctx);
    const urls = ctx.listings.listPublic().map((listing) => {
      const location = `${baseUrl}/projects/${encodeURIComponent(listing.slug)}`;
      return `<url><loc>${escapeXml(location)}</loc><lastmod>${escapeXml(toIsoDate(listing.updated_at))}</lastmod></url>`;
    });
    res
      .type('application/xml')
      .set('Cache-Control', CACHE_PUBLIC)
      .send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${escapeXml(baseUrl)}/</loc></url>${urls.join('')}</urlset>`);
  });

  router.get('/', (req: Request, res: Response) => {
    const ctx = getCtx(req);
    const allListings = publicListings(ctx);
    const query = singleQuery(req.query.q).slice(0, 120);
    const category = singleQuery(req.query.category).slice(0, 60);
    const visibleListings = filterListings(allListings, query, category);
    const visibleSlugs = new Set(visibleListings.map(({ listing }) => listing.slug));
    const categories = [...new Set(allListings.map(({ listing }) => listing.category))]
      .sort((a, b) => a.localeCompare(b));

    setPublicDocumentHeaders(res)
      .type('html')
      .set('Cache-Control', CACHE_PUBLIC)
      .set('X-Robots-Tag', 'index, follow')
      .send(renderBrowsePage({
        baseUrl: publicBaseUrl(req, ctx),
        listings: allListings,
        visibleSlugs,
        categories,
        query,
        category,
      }));
  });

  router.get('/projects/:slug', (req: Request, res: Response) => {
    const ctx = getCtx(req);
    const slug = Array.isArray(req.params.slug) ? req.params.slug[0] : req.params.slug;
    const listing = ctx.listings.findBySlug(slug);
    if (!listing || listing.status !== 'approved' || !safeRepositoryUrl(listing.repo_url)) {
      sendPublicNotFound(res);
      return;
    }

    const creator = ctx.store.findByGitHubId(listing.creator_github_id);
    if (!creator) {
      sendPublicNotFound(res);
      return;
    }

    setPublicDocumentHeaders(res)
      .type('html')
      .set('Cache-Control', CACHE_PUBLIC)
      .set('X-Robots-Tag', 'index, follow')
      .send(renderDetailPage({
        baseUrl: publicBaseUrl(req, ctx),
        listing,
        creatorLogin: creator.github_login,
      }));
  });

  return router;
}

function publicListings(ctx: AppContext): PublicListing[] {
  return ctx.listings.listPublic().flatMap((listing) => {
    const creator = ctx.store.findByGitHubId(listing.creator_github_id);
    return creator ? [{ listing, creatorLogin: creator.github_login }] : [];
  });
}

function filterListings(listings: PublicListing[], query: string, category: string): PublicListing[] {
  const needle = query.trim().toLocaleLowerCase();
  const wantedCategory = category.trim().toLocaleLowerCase();
  return listings.filter(({ listing, creatorLogin }) => {
    if (wantedCategory && listing.category.toLocaleLowerCase() !== wantedCategory) return false;
    if (!needle) return true;
    return [
      listing.title,
      listing.short_description,
      listing.full_description,
      listing.category,
      creatorLogin,
    ].some((value) => value.toLocaleLowerCase().includes(needle));
  });
}

function renderBrowsePage(input: {
  baseUrl: string;
  listings: PublicListing[];
  visibleSlugs: Set<string>;
  categories: string[];
  query: string;
  category: string;
}): string {
  const { baseUrl, listings, visibleSlugs, categories, query, category } = input;
  const cards = listings.map((project) => renderProjectCard(project, !visibleSlugs.has(project.listing.slug))).join('');
  const categoryOptions = categories.map((item) => (
    `<option value="${escapeAttr(item)}"${item.toLocaleLowerCase() === category.toLocaleLowerCase() ? ' selected' : ''}>${escapeHtml(item)}</option>`
  )).join('');
  const hasFilters = Boolean(query || category);
  const emptyText = hasFilters
    ? 'No approved projects match these filters.'
    : 'No approved projects have been published yet.';

  return documentShell({
    title: 'OWLLM Marketplace — Community projects',
    description: 'Browse approved OWLLM projects shared by the community. No account is required.',
    canonicalUrl: `${baseUrl}/`,
    body: `
      <header class="site-header">
        <a class="brand" href="/" aria-label="OWLLM Marketplace home"><span class="brand-mark" aria-hidden="true">O</span><span>OWLLM <strong>Marketplace</strong></span></a>
        <span class="anonymous-badge">Browse anonymously · no account required</span>
      </header>
      <main>
        <section class="hero" aria-labelledby="marketplace-title">
          <p class="eyebrow">Community-built · human-reviewed</p>
          <h1 id="marketplace-title">Find your next OWLLM project</h1>
          <p>Explore approved projects without signing in. Marketplace links only take you to external pages; OWLLM never downloads, installs, or runs repository content.</p>
        </section>
        <section class="browse" aria-labelledby="browse-title">
          <div class="section-heading">
            <div><p class="eyebrow">Discover</p><h2 id="browse-title">Approved projects</h2></div>
            <output id="result-count" class="result-count" aria-live="polite">${visibleSlugs.size} ${visibleSlugs.size === 1 ? 'project' : 'projects'}</output>
          </div>
          <form id="marketplace-filters" class="filters" method="get" action="/" role="search">
            <label class="search-field"><span>Search projects</span><input id="project-search" type="search" name="q" value="${escapeAttr(query)}" placeholder="Search by name, creator, or description" autocomplete="off"></label>
            <label class="category-field"><span>Category</span><select id="project-category" name="category"><option value="">All categories</option>${categoryOptions}</select></label>
            <button type="submit">Apply filters</button>
            <a class="clear-filter${hasFilters ? '' : ' is-hidden'}" id="clear-filters" href="/">Clear</a>
          </form>
          <div id="project-grid" class="project-grid">${cards}</div>
          <p id="empty-results" class="empty-state${visibleSlugs.size ? ' is-hidden' : ''}">${escapeHtml(emptyText)}</p>
        </section>
        ${safetyNote()}
      </main>`,
    scripts: '<script src="/marketplace.js" defer></script>',
  });
}

function renderProjectCard({ listing, creatorLogin }: PublicListing, hidden: boolean): string {
  const screenshots = safeScreenshotUrls(listing);
  const screenshot = screenshots[0];
  const searchText = [listing.title, listing.short_description, listing.full_description, listing.category, creatorLogin]
    .join(' ')
    .toLocaleLowerCase();
  const image = screenshot
    ? `<img src="${escapeAttr(screenshot)}" alt="Preview of ${escapeAttr(listing.title)}" loading="lazy" referrerpolicy="no-referrer">`
    : '<div class="project-placeholder" aria-hidden="true">OWL</div>';

  return `<article class="project-card" data-project-card data-category="${escapeAttr(listing.category.toLocaleLowerCase())}" data-search="${escapeAttr(searchText)}"${hidden ? ' hidden' : ''}>
    <a class="card-link" href="/projects/${encodeURIComponent(listing.slug)}" aria-label="View ${escapeAttr(listing.title)} project details">
      <div class="card-media">${image}<span class="category-chip">${escapeHtml(listing.category)}</span></div>
      <div class="card-body"><h3>${escapeHtml(listing.title)}</h3><p>${escapeHtml(listing.short_description)}</p><div class="card-meta"><span>By ${escapeHtml(creatorLogin)}</span><span>${escapeHtml(listing.spdx_license)}</span></div><span class="details-label">View project details <span aria-hidden="true">→</span></span></div>
    </a>
  </article>`;
}

function renderDetailPage(input: { baseUrl: string; listing: Listing; creatorLogin: string }): string {
  const { baseUrl, listing, creatorLogin } = input;
  const canonicalUrl = `${baseUrl}/projects/${encodeURIComponent(listing.slug)}`;
  const repoUrl = safeRepositoryUrl(listing.repo_url);
  if (!repoUrl) return renderGenericNotFound();
  const demoUrl = safeHttpsUrl(listing.demo_url);
  const screenshots = safeScreenshotUrls(listing);
  const gallery = screenshots.length
    ? `<section class="gallery" aria-labelledby="screenshots-title"><div class="section-heading"><div><p class="eyebrow">Gallery</p><h2 id="screenshots-title">Screenshots</h2></div><span>${screenshots.length} ${screenshots.length === 1 ? 'image' : 'images'}</span></div><div class="screenshot-grid">${screenshots.map((url, index) => `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer external" aria-label="Open screenshot ${index + 1} on the external image host"><img src="${escapeAttr(url)}" alt="${escapeAttr(listing.title)} screenshot ${index + 1}" loading="${index === 0 ? 'eager' : 'lazy'}" referrerpolicy="no-referrer"></a>`).join('')}</div></section>`
    : '';
  const demoAction = demoUrl
    ? `<a class="action secondary" href="${escapeAttr(demoUrl)}" target="_blank" rel="noopener noreferrer external"><span>Open live demo</span><small>External site · nothing is installed</small></a>`
    : '';
  const creatorUrl = `https://github.com/${encodeURIComponent(creatorLogin)}`;
  const structuredData = safeJson({
    '@context': 'https://schema.org',
    '@type': 'SoftwareSourceCode',
    name: listing.title,
    description: listing.short_description,
    codeRepository: repoUrl,
    license: listing.spdx_license,
    url: canonicalUrl,
    author: { '@type': 'Person', name: creatorLogin, url: creatorUrl },
    image: screenshots,
  });

  return documentShell({
    title: `${listing.title} — OWLLM Marketplace`,
    description: listing.short_description,
    canonicalUrl,
    imageUrl: screenshots[0],
    structuredData,
    body: `
      <header class="site-header"><a class="brand" href="/" aria-label="OWLLM Marketplace home"><span class="brand-mark" aria-hidden="true">O</span><span>OWLLM <strong>Marketplace</strong></span></a><a class="back-link" href="/">← Browse projects</a></header>
      <main class="detail-main">
        <article class="project-detail">
          <div class="detail-copy"><p class="eyebrow">${escapeHtml(listing.category)} · Approved listing</p><h1>${escapeHtml(listing.title)}</h1><p class="lead">${escapeHtml(listing.short_description)}</p><div class="identity-row"><span>Created by <a href="${escapeAttr(creatorUrl)}" target="_blank" rel="noopener noreferrer external">${escapeHtml(creatorLogin)} <span class="sr-only">(external GitHub profile)</span></a></span><span>License <strong>${escapeHtml(listing.spdx_license)}</strong></span></div></div>
          <aside class="action-panel" aria-label="External project links">
            <h2>Explore externally</h2>
            <p>These links leave OWLLM. Review the project and its license before using anything.</p>
            <a class="action primary" href="${escapeAttr(repoUrl)}" target="_blank" rel="noopener noreferrer external"><span>View source repository</span><small>Opens GitHub · no download or execution</small></a>
            ${demoAction}
          </aside>
        </article>
        ${gallery}
        <section class="description" aria-labelledby="description-title"><p class="eyebrow">About</p><h2 id="description-title">Project description</h2><div class="description-copy">${escapeHtml(listing.full_description)}</div></section>
        ${safetyNote()}
      </main>`,
  });
}

function safetyNote(): string {
  return '<aside class="safety-note"><strong>Marketplace safety</strong><p>Listings are informational. OWLLM does not clone, download, install, execute, or validate repository or demo content. External links are clearly marked and open separately.</p></aside>';
}

function documentShell(input: {
  title: string;
  description: string;
  canonicalUrl: string;
  body: string;
  imageUrl?: string;
  structuredData?: string;
  scripts?: string;
}): string {
  const description = input.description.slice(0, 240);
  const image = input.imageUrl ? `<meta property="og:image" content="${escapeAttr(input.imageUrl)}">` : '';
  const structuredData = input.structuredData ? `<script type="application/ld+json">${input.structuredData}</script>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="index,follow,max-image-preview:large"><title>${escapeHtml(input.title)}</title><meta name="description" content="${escapeAttr(description)}"><link rel="canonical" href="${escapeAttr(input.canonicalUrl)}"><meta property="og:type" content="website"><meta property="og:title" content="${escapeAttr(input.title)}"><meta property="og:description" content="${escapeAttr(description)}"><meta property="og:url" content="${escapeAttr(input.canonicalUrl)}">${image}<link rel="stylesheet" href="/marketplace.css">${structuredData}</head><body>${input.body}<footer><span>OWLLM Marketplace</span><span>Approved community listings · browse without an account</span></footer>${input.scripts ?? ''}</body></html>`;
}

function sendPublicNotFound(res: Response): void {
  setPublicDocumentHeaders(res)
    .status(404)
    .type('html')
    .set('Cache-Control', 'no-store')
    .set('X-Robots-Tag', 'noindex, nofollow')
    .send(renderGenericNotFound());
}

function setPublicDocumentHeaders(res: Response): Response {
  return res
    .set('Content-Security-Policy', "default-src 'self'; img-src https: data:; style-src 'self'; script-src 'self'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'self'")
    .set('Referrer-Policy', 'no-referrer')
    .set('X-Content-Type-Options', 'nosniff')
    .set('X-Frame-Options', 'DENY')
    .set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
}

function renderGenericNotFound(): string {
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Project not found — OWLLM Marketplace</title><link rel="stylesheet" href="/marketplace.css"></head><body><main class="not-found"><p class="eyebrow">404</p><h1>Project not found</h1><p>This project is unavailable or is not publicly published.</p><a class="action primary" href="/">Browse approved projects</a></main></body></html>';
}

function publicBaseUrl(req: Request, ctx: AppContext): string {
  if (ctx.config.publicBaseUrl) return ctx.config.publicBaseUrl;
  return `${req.protocol}://${req.get('host') ?? `localhost:${ctx.config.port}`}`.replace(/\/$/, '');
}

function singleQuery(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function safeRepositoryUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parts.length !== 2) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function safeHttpsUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function safeScreenshotUrls(listing: Listing): string[] {
  try {
    const parsed = JSON.parse(listing.screenshots);
    return Array.isArray(parsed)
      ? parsed.flatMap((value) => typeof value === 'string' ? [safeHttpsUrl(value)] : []).filter((value): value is string => Boolean(value))
      : [];
  } catch {
    return [];
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function escapeXml(value: string): string {
  return escapeHtml(value);
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/-->/g, '--\\u003e');
}

function toIsoDate(sqliteDate: string): string {
  const normalized = sqliteDate.includes('T') ? sqliteDate : `${sqliteDate.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.valueOf()) ? new Date(0).toISOString() : parsed.toISOString();
}

const MARKETPLACE_JS = `(() => {
  const form = document.querySelector('#marketplace-filters');
  const search = document.querySelector('#project-search');
  const category = document.querySelector('#project-category');
  const cards = [...document.querySelectorAll('[data-project-card]')];
  const count = document.querySelector('#result-count');
  const empty = document.querySelector('#empty-results');
  const clear = document.querySelector('#clear-filters');
  if (!form || !search || !category || !count || !empty || !clear) return;
  form.addEventListener('submit', (event) => event.preventDefault());
  const apply = () => {
    const needle = search.value.trim().toLocaleLowerCase();
    const selected = category.value.toLocaleLowerCase();
    let visible = 0;
    for (const card of cards) {
      const match = (!needle || card.dataset.search.includes(needle)) && (!selected || card.dataset.category === selected);
      card.hidden = !match;
      if (match) visible += 1;
    }
    count.textContent = visible + (visible === 1 ? ' project' : ' projects');
    empty.classList.toggle('is-hidden', visible !== 0);
    clear.classList.toggle('is-hidden', !needle && !selected);
    const params = new URLSearchParams();
    if (search.value.trim()) params.set('q', search.value.trim());
    if (category.value) params.set('category', category.value);
    history.replaceState(null, '', params.size ? '/?' + params.toString() : '/');
  };
  search.addEventListener('input', apply);
  category.addEventListener('change', apply);
  clear.addEventListener('click', (event) => { event.preventDefault(); search.value = ''; category.value = ''; apply(); search.focus(); });
})();`;

const MARKETPLACE_CSS = `
:root{color-scheme:dark;--bg:#080b12;--panel:#111722;--panel-2:#171f2d;--ink:#f5f7fb;--muted:#aab5c6;--line:#293448;--accent:#84f4c8;--accent-ink:#04281c;--radius:20px;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% -10%,#173b3c 0,transparent 38%),var(--bg);color:var(--ink);min-height:100vh}a{color:inherit}img{display:block;max-width:100%}.site-header,main,footer{width:min(1180px,calc(100% - 40px));margin-inline:auto}.site-header{height:78px;display:flex;align-items:center;justify-content:space-between;gap:20px}.brand{display:flex;align-items:center;gap:11px;text-decoration:none;font-size:18px}.brand-mark{display:grid;place-items:center;width:34px;height:34px;border-radius:10px;background:var(--accent);color:var(--accent-ink);font-weight:900}.brand strong{color:var(--accent)}.anonymous-badge,.back-link{color:var(--muted);font-size:14px}.back-link:hover{color:var(--ink)}.hero{padding:78px 0 64px;max-width:780px}.eyebrow{margin:0 0 12px;color:var(--accent);font-size:12px;font-weight:800;letter-spacing:.16em;text-transform:uppercase}.hero h1,.project-detail h1{margin:0;font-size:clamp(42px,7vw,76px);line-height:.98;letter-spacing:-.055em}.hero>p:last-child{max-width:680px;margin:24px 0 0;color:var(--muted);font-size:18px;line-height:1.65}.browse{padding-bottom:54px}.section-heading{display:flex;align-items:end;justify-content:space-between;gap:20px;margin-bottom:22px}.section-heading h2,.description h2,.gallery h2{font-size:30px;letter-spacing:-.03em;margin:0}.result-count,.section-heading>span{color:var(--muted)}.filters{display:grid;grid-template-columns:minmax(260px,1fr) minmax(180px,260px) auto auto;align-items:end;gap:12px;margin-bottom:26px;padding:16px;background:rgba(17,23,34,.86);border:1px solid var(--line);border-radius:var(--radius);backdrop-filter:blur(12px)}.filters label{display:grid;gap:7px;color:var(--muted);font-size:12px;font-weight:700}.filters input,.filters select{width:100%;min-height:46px;border:1px solid var(--line);border-radius:12px;background:#0b1019;color:var(--ink);padding:0 14px;font:inherit;outline:none}.filters input:focus,.filters select:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(132,244,200,.12)}.filters button,.clear-filter{min-height:46px;border:0;border-radius:12px;padding:0 18px;display:inline-grid;place-items:center;font:700 14px inherit;text-decoration:none;cursor:pointer}.filters button{background:var(--accent);color:var(--accent-ink)}.clear-filter{color:var(--muted)}.project-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:18px}.project-card{min-width:0;border:1px solid var(--line);border-radius:var(--radius);overflow:hidden;background:linear-gradient(145deg,var(--panel-2),var(--panel));transition:transform .2s,border-color .2s}.project-card:hover{transform:translateY(-4px);border-color:#52647e}.project-card[hidden]{display:none}.card-link{height:100%;display:flex;flex-direction:column;text-decoration:none}.card-media{position:relative;aspect-ratio:16/9;overflow:hidden;background:#0c121c}.card-media img{width:100%;height:100%;object-fit:cover;transition:transform .35s}.project-card:hover .card-media img{transform:scale(1.025)}.project-placeholder{height:100%;display:grid;place-items:center;color:#26344b;font-size:34px;font-weight:900;letter-spacing:.18em;background:radial-gradient(circle at 70% 15%,#214345,transparent 50%),#0d131e}.category-chip{position:absolute;left:12px;bottom:12px;padding:6px 9px;border-radius:99px;background:rgba(5,9,15,.86);border:1px solid rgba(255,255,255,.15);font-size:11px;font-weight:800}.card-body{padding:20px;display:flex;flex:1;flex-direction:column}.card-body h3{margin:0 0 9px;font-size:21px;letter-spacing:-.025em}.card-body>p{margin:0;color:var(--muted);line-height:1.55}.card-meta{display:flex;justify-content:space-between;gap:12px;margin-top:20px;padding-top:15px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}.details-label{margin-top:15px;color:var(--accent);font-weight:800;font-size:13px}.empty-state{padding:60px 24px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:var(--radius)}.is-hidden{display:none!important}.safety-note{margin:0 0 64px;padding:20px 22px;border-left:3px solid var(--accent);border-radius:0 14px 14px 0;background:rgba(132,244,200,.07)}.safety-note strong{color:var(--accent)}.safety-note p{margin:6px 0 0;color:var(--muted);line-height:1.55}.detail-main{padding-top:52px}.project-detail{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(290px,.7fr);gap:44px;align-items:start;padding:34px 0 68px}.project-detail h1{font-size:clamp(40px,6vw,68px)}.lead{max-width:720px;color:var(--muted);font-size:20px;line-height:1.55}.identity-row{display:flex;flex-wrap:wrap;gap:12px 28px;margin-top:28px;color:var(--muted)}.identity-row a{color:var(--accent)}.identity-row strong{color:var(--ink)}.action-panel{padding:24px;border:1px solid var(--line);border-radius:var(--radius);background:var(--panel)}.action-panel h2{margin:0;font-size:20px}.action-panel>p{color:var(--muted);font-size:14px;line-height:1.55}.action{display:flex;flex-direction:column;gap:3px;margin-top:12px;padding:14px 16px;border-radius:12px;text-decoration:none;font-weight:800}.action small{font-weight:500;opacity:.72}.action.primary{background:var(--accent);color:var(--accent-ink)}.action.secondary{border:1px solid var(--line);background:var(--panel-2)}.gallery,.description{padding:42px 0;border-top:1px solid var(--line)}.screenshot-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.screenshot-grid a{display:block;border-radius:16px;overflow:hidden;border:1px solid var(--line);background:var(--panel)}.screenshot-grid img{width:100%;aspect-ratio:16/9;object-fit:cover}.description-copy{max-width:820px;color:#d7deea;white-space:pre-wrap;font-size:17px;line-height:1.75}footer{display:flex;justify-content:space-between;gap:20px;padding:28px 0 40px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}.not-found{max-width:620px;padding:14vh 0}.not-found h1{font-size:52px;margin:0}.not-found>p:not(.eyebrow){color:var(--muted);font-size:18px}.not-found .action{width:max-content}.creator-nav{display:flex;gap:16px;color:var(--muted);font-size:14px}.creator-nav a,.creator-link{color:var(--accent);font-weight:800;text-decoration:none}.creator-main{width:min(1180px,calc(100% - 40px));margin:0 auto;padding:42px 0 70px}.creator-narrow{max-width:720px}.creator-heading{display:flex;align-items:start;justify-content:space-between;gap:20px;margin-bottom:26px}.creator-heading h1,.creator-narrow h1{margin:0;font-size:clamp(36px,6vw,62px);line-height:1;letter-spacing:-.045em}.creator-muted{color:var(--muted);line-height:1.6}.creator-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.creator-card,.creator-form,.creator-warning,.creator-error,.creator-empty{border:1px solid var(--line);border-radius:var(--radius);background:linear-gradient(145deg,rgba(23,31,45,.96),rgba(17,23,34,.92));box-shadow:0 20px 60px rgba(0,0,0,.24)}.creator-card{padding:22px}.creator-card-top{display:flex;align-items:start;justify-content:space-between;gap:16px}.creator-card h2{margin:0;font-size:23px;letter-spacing:-.025em}.creator-card p{color:var(--muted);line-height:1.55}.creator-card dl{display:grid;gap:10px;margin:18px 0}.creator-card dt{color:var(--muted);font-size:12px;font-weight:800;text-transform:uppercase}.creator-card dd{margin:3px 0 0;overflow-wrap:anywhere}.creator-actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center}.creator-actions a,.creator-actions button,.creator-form-actions button,.primary-button{min-height:40px;border:1px solid var(--line);border-radius:12px;background:#0b1019;color:var(--ink);padding:0 14px;font:800 13px inherit;text-decoration:none;cursor:pointer}.creator-actions .danger{border-color:#8a3542;color:#ffb8c1}.primary-button,.creator-form-actions .primary-button{border:0;background:var(--accent);color:var(--accent-ink)}.status-pill{display:inline-grid;place-items:center;min-height:28px;border-radius:999px;padding:0 10px;font-size:11px;font-weight:900;text-transform:uppercase}.status-draft{background:#2b3444;color:#d6deea}.status-pending{background:#3d3215;color:#f9d77b}.status-approved{background:#123c2f;color:#8cf2c9}.status-rejected{background:#4b1722;color:#ffbdc6}.status-withdrawn{background:#2b2430;color:#cfbfd7}.creator-good{color:#8cf2c9!important}.creator-rejection,.creator-warning{color:#ffd5db}.creator-warning,.creator-error,.creator-empty{padding:18px 20px;margin-bottom:18px}.creator-warning strong{color:#ffced6}.creator-warning p{margin:.35rem 0 0;color:#ffc5ce;line-height:1.5}.creator-error{border-color:#8a3542;color:#ffd5db;background:#33151d}.creator-form{display:grid;gap:16px;padding:22px}.creator-form label{display:grid;gap:7px;color:var(--muted);font-size:12px;font-weight:800}.creator-form input,.creator-form textarea{width:100%;border:1px solid var(--line);border-radius:12px;background:#0b1019;color:var(--ink);padding:12px 14px;font:inherit;outline:none}.creator-form textarea{min-height:120px;resize:vertical}.creator-form input:focus,.creator-form textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(132,244,200,.12)}.creator-two{display:grid;grid-template-columns:1fr 1fr;gap:14px}.creator-check{grid-template-columns:auto 1fr!important;align-items:start;padding:14px;border:1px solid #856b2d;border-radius:12px;background:#271f10;color:#ffe3a3!important}.creator-check input{width:auto;margin-top:2px}.creator-form-actions{display:flex;justify-content:flex-end;gap:10px}.compact{width:max-content}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:900px){.project-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.filters{grid-template-columns:1fr 1fr}.project-detail{grid-template-columns:1fr}.action-panel{max-width:620px}}
@media(max-width:760px){.creator-main{width:min(100% - 24px,1180px);padding-top:28px}.creator-heading,.creator-card-top{flex-direction:column}.creator-grid,.creator-two{grid-template-columns:1fr}.creator-form-actions{justify-content:stretch;flex-direction:column}.creator-form-actions button,.creator-actions a,.creator-actions button{width:100%}.creator-nav{width:100%;justify-content:space-between}.creator-card{padding:18px}.creator-form{padding:18px}}
@media(max-width:620px){.site-header,main,footer{width:min(100% - 24px,1180px)}.site-header{height:auto;min-height:70px;align-items:flex-start;padding:16px 0}.anonymous-badge{max-width:170px;text-align:right}.hero{padding:48px 0}.hero h1{font-size:44px}.filters,.project-grid,.screenshot-grid{grid-template-columns:1fr}.filters button,.clear-filter{width:100%}.section-heading{align-items:flex-start}.project-detail{padding-top:16px;gap:24px}.identity-row,footer{flex-direction:column}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}
`;
