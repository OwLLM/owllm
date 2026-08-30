import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";

const site = process.env.SITE_URL || "https://owllm.com";

export default defineConfig({
  site,
  output: "static",
  devToolbar: {
    enabled: false,
  },
  integrations: [react(), sitemap()],
  image: {
    service: {
      entrypoint: "astro/assets/services/sharp",
    },
  },
  vite: {
    css: {
      devSourcemap: true,
    },
  },
});
