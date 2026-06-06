import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";

// Resolve LocaLLM/icons relative to this config file
// (owllm-desktop/ui/ after Phase 5 dropped the apps/ wrapper).
// We expose it to the dev server as `/Page_icons/...` etc. so AgentsPage can
// reference real source PNGs via root-relative URLs without any build step
// copying them into the project.
const ICONS_DIR = path.resolve(__dirname, "../../icons");

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      // Dev: serve <repo>/icons/<sub>/... at /<sub>/... via middleware.
      // Build: copy the *used* icon subfolders into dist/ so the same
      //        URLs work when Tauri serves the static bundle. We don't
      //        use Vite's `publicDir` because that would force-copy
      //        the entire ~100 MB icons/ tree on every build; the
      //        whitelist below keeps the bundle to ~25 MB.
      name: "serve-localllm-icons",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!req.url || (req.method !== "GET" && req.method !== "HEAD")) return next();
          const urlPath = req.url.split("?", 1)[0];
          const candidate = path.join(ICONS_DIR, decodeURIComponent(urlPath));
          if (!candidate.startsWith(ICONS_DIR + path.sep)) return next();
          fs.stat(candidate, (err, stat) => {
            if (err || !stat.isFile()) return next();
            res.setHeader(
              "Content-Type",
              candidate.endsWith(".svg") ? "image/svg+xml" : "image/png",
            );
            fs.createReadStream(candidate).pipe(res);
          });
        });
      },
      writeBundle() {
        // vite.config.ts lives in apps/owllm-desktop/ui/; `root: "ui"`
        // makes the build output land in apps/owllm-desktop/ui/dist/.
        const distDir = path.resolve(__dirname, "dist");
        const want = ["Page_icons", "Backgrounds", "3d"];
        for (const sub of want) {
          const src = path.join(ICONS_DIR, sub);
          const dst = path.join(distDir, sub);
          if (!fs.existsSync(src)) continue;
          fs.rmSync(dst, { recursive: true, force: true });
          fs.cpSync(src, dst, { recursive: true });
        }
      },
    },
  ],
  // `npm` commands run from `apps/owllm-desktop/`, but the Vite project lives in `./ui`.
  root: "ui",
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    fs: {
      allow: [path.resolve(__dirname, ".."), ICONS_DIR],
    },
  },
  build: {
    // Written to `apps/owllm-desktop/ui/dist` (Tauri `frontendDist` points here)
    outDir: "dist",
    target: "es2020",
  },
});
