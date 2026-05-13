import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs";

// Resolve LocaLLM/icons relative to this config file (apps/owllm-desktop/ui/).
// We expose it to the dev server as `/Page_icons/...` etc. so AgentsPage can
// reference real source PNGs via root-relative URLs without any build step
// copying them into the project.
const ICONS_DIR = path.resolve(__dirname, "../../../icons");

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      // Dev-only middleware: serve <repo>/icons subfolders at the URL root,
      // so <img src="/Page_icons/owl_agentic.png"> just works. We don't use
      // Vite's `publicDir` because that would copy ~100MB of icons into
      // the Tauri production bundle on every build.
      name: "serve-localllm-icons",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!req.url || (req.method !== "GET" && req.method !== "HEAD")) return next();
          const urlPath = req.url.split("?", 1)[0];
          const candidate = path.join(ICONS_DIR, decodeURIComponent(urlPath));
          // Path-traversal guard: candidate MUST live under ICONS_DIR.
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
