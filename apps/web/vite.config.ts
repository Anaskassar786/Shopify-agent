import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

/**
 * Embedded app dev server. The API owns /api + /shopify in every environment;
 * in dev, Vite proxies them so the browser only ever talks to one origin for
 * app + API (identical shape to production, where the API serves this bundle).
 * Binding 0.0.0.0 + e2b host allowlist keeps the sandbox preview working —
 * localhost is NEVER referenced by browser code.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    allowedHosts: true,
    proxy: {
      "/api": {
        target: process.env["API_PROXY_TARGET"] ?? "http://localhost:3000",
        changeOrigin: false,
      },
      "/shopify": {
        target: process.env["API_PROXY_TARGET"] ?? "http://localhost:3000",
        changeOrigin: false,
      },
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 4173,
    allowedHosts: true,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
    chunkSizeWarningLimit: 700,
  },
});
