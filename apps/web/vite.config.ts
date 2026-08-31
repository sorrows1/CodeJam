import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // The opaque preview CSP is scoped to the browser-facing authenticated
      // content path. Preserve that host instead of rewriting it to the API
      // target, or sandboxed CSS/JS URLs will not match their exact CSP source.
      "/api": { target: "http://127.0.0.1:3000", changeOrigin: false },
    },
  },
});
