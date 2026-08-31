import { defineConfig } from '/verifier/node_modules/vite/dist/node/index.js';
import vue from '/verifier/node_modules/@vitejs/plugin-vue/dist/index.mjs';

const maxInlineAssetBytes = 2 * 1024 * 1024;

export default defineConfig({
  base: './',
  cacheDir: '/tmp/vite-cache',
  plugins: [vue()],
  css: { postcss: { plugins: [] } },
  resolve: {
    alias: [
      { find: /^react\/jsx-runtime$/, replacement: '/verifier/node_modules/react/jsx-runtime.js' },
      { find: /^react\/jsx-dev-runtime$/, replacement: '/verifier/node_modules/react/jsx-dev-runtime.js' },
      { find: /^react$/, replacement: '/verifier/node_modules/react/index.js' },
      { find: /^react-dom\/client$/, replacement: '/verifier/node_modules/react-dom/client.js' },
      { find: /^react-dom$/, replacement: '/verifier/node_modules/react-dom/index.js' },
      { find: /^vue$/, replacement: '/verifier/node_modules/vue/dist/vue.esm-browser.prod.js' },
    ],
  },
  build: {
    assetsInlineLimit: maxInlineAssetBytes,
    sourcemap: false,
    minify: true,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
