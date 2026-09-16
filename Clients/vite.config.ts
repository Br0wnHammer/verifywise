// Node 25+ ships an experimental `localStorage` global that warns when read
// without `--localstorage-file`. `docx` reads `localStorage` at module load,
// so install a tiny in-memory stub before any imports run.
const localStorageStore = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => localStorageStore.get(key) ?? null,
    setItem: (key: string, value: string) => localStorageStore.set(key, String(value)),
    removeItem: (key: string) => localStorageStore.delete(key),
    clear: () => localStorageStore.clear(),
    get length() {
      return localStorageStore.size;
    },
    key: (index: number) => Array.from(localStorageStore.keys())[index] ?? null,
  },
  configurable: true,
  writable: true,
});

import svgr from "@svgr/rollup";
import react from "@vitejs/plugin-react";
import path from "path";
import { defineConfig } from "vitest/config";
import { version } from "../version.json";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), svgr()],
  resolve: {
    alias: {
      "@user-guide-content": path.resolve(__dirname, "../shared/user-guide-content"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: process.env.VITE_APP_PORT ? parseInt(process.env.VITE_APP_PORT) : 5173,
    proxy: {
      // Forward all API requests to Node.js server which handles auth and proxies to FastAPI
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        secure: false,
        timeout: 120000,
        configure: (proxy) => {
          proxy.on("error", (err) => {
            console.error("[vite proxy error]", err.message);
          });
        },
      },
    },
  },
  build: {
    // Generate manifest for cache busting
    manifest: true,
    chunkSizeWarningLimit: 500,
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        // Add hash to filenames for cache busting
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash].[ext]",
        // Native rolldown chunk groups. `includeDependenciesRecursively: false`
        // keeps each group limited to the packages it matches — with the old
        // manualChunks function, group dependency capture pulled unrelated
        // modules (e.g. react/jsx-runtime into vendor-editor, @xyflow/react and
        // @tiptap/react into vendor-react) onto the critical path.
        advancedChunks: {
          includeDependenciesRecursively: false,
          groups: [
            {
              name: "vendor-react",
              test: /node_modules\/(react|react-dom|scheduler|react-router)\//,
              priority: 20,
            },
            {
              name: "vendor-mui",
              test: /node_modules\/@mui\/(material|lab|x-charts|x-date-pickers)\//,
              priority: 10,
            },
            {
              name: "vendor-state",
              test: /node_modules\/(@reduxjs\/toolkit|react-redux|redux-persist|@tanstack\/react-query)\//,
              priority: 10,
            },
            {
              name: "vendor-editor",
              test: /node_modules\/@tiptap\//,
              priority: 10,
            },
            {
              name: "vendor-charts",
              test: /node_modules\/(recharts|html2canvas)\//,
              priority: 10,
            },
          ],
        },
      },
    },
  },
  define: {
    global: "globalThis",
    // Use environment variable if available (for CI/CD), otherwise use package.json version
    __APP_VERSION__: JSON.stringify(process.env.VITE_APP_VERSION || version),
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    globals: true,
    testTimeout: 20000,
    exclude: ["e2e/**", "**/node_modules/**"],
    env: {
      VITE_APP_API_BASE_URL: "http://localhost:3000",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary"],
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: [
        "src/test/**",
        "src/mocks/**",
        "src/**/*.d.ts",
        "vite.config.ts",
        "**/node_modules/**",
        "src/**/**/tests/**",
        "src/i18n/**",
      ],
      thresholds: {
        statements: 50,
        branches: 40,
        functions: 45,
        lines: 50,
      },
    },
  },
});
