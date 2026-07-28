# owllm-website

Standalone marketing website for OwLLM, built with [Astro 5](https://astro.build/) and React islands.

> This package is intentionally self-contained. It does **not** import from `owllm-desktop/` or any other package in the monorepo. Selected assets and design-token values were copied from the desktop app to keep the website independent.

## Stack

- **Astro 5** with `@astrojs/react` islands and `output: 'static'`
- **@astrojs/sitemap** for sitemap generation
- **React 18.3** for the theme toggle island only
- **TypeScript** and **Sharp** for image optimization

## Install

```bash
cd owllm-website
npm install
```

## Development

```bash
npm run dev
```

Open <http://localhost:4321>.

## Build & preview

```bash
npm run build
npm run preview
```

## Lint & format

```bash
npm run lint      # astro check
npm run format    # prettier --write .
```

## Sync release metadata

```bash
npm run sync:release
```

This fetches the latest release from `https://api.github.com/repos/OwLLM/owllm/releases/latest` and writes it to `src/data/release.json`. If the network is unavailable, the script falls back to `src/data/release.local.json`.

## Deployment

### Netlify

1. Connect the repository to Netlify.
2. Set **Build command** to `npm run build`.
3. Set **Publish directory** to `dist/`.
4. Add environment variables from `.env.example` if needed (`SITE_URL`, `PUBLIC_GITHUB_REPO`).

### Cloudflare Pages

1. Connect the repository in the Cloudflare dashboard.
2. Set **Build command** to `npm run build`.
3. Set **Build output directory** to `dist/`.
4. Add environment variables from `.env.example` if needed.

## Accessibility

- Skip-to-content link is the first focusable element.
- All interactive controls have visible `:focus-visible` indicators (`outline: 2px solid var(--accent)`).
- Mobile navigation uses `aria-expanded`, `aria-controls`, `aria-modal`, and closes on `Escape`.
- Color contrast is verified against both dark and light mode surfaces.
- `prefers-reduced-motion` removes animations.

## Environment variables

Copy `.env.example` to `.env` and adjust:

```bash
SITE_URL=https://owllm.com
PUBLIC_GITHUB_REPO=OwLLM/owllm
```
