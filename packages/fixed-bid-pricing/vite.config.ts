import { defineConfig } from "vite-plus";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./__tests__/cloudflare-workers.ts", import.meta.url),
      ),
    },
  },
});
