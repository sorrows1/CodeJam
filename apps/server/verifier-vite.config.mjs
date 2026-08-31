import { defineConfig } from 'vite';

export default defineConfig({
  cacheDir: '/tmp/vite-cache',
  resolve: {
    alias: [
      { find: /^react$/, replacement: '/verifier/node_modules/react/index.js' },
      { find: /^react\/jsx-runtime$/, replacement: '/verifier/node_modules/react/jsx-runtime.js' },
      { find: /^react\/jsx-dev-runtime$/, replacement: '/verifier/node_modules/react/jsx-dev-runtime.js' },
      { find: /^react-dom$/, replacement: '/verifier/node_modules/react-dom/index.js' },
      { find: /^react-dom\/client$/, replacement: '/verifier/node_modules/react-dom/client.js' },
    ],
  },
});
