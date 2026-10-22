import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { tideDpopPlugin } from "@tidecloak/js/vite";
import { defineConfig } from "vite";

// The adapter written by tidecloak/bootstrap.py. One copy for the whole app: the backend reads the
// same file. It holds the realm's PUBLIC keys and ids, nothing secret.
const adapterPath = process.env.TIDECLOAK_ADAPTER ?? fileURLToPath(new URL("../../tidecloak.json", import.meta.url));
let adapter: Record<string, unknown> = {};
try {
  adapter = JSON.parse(readFileSync(adapterPath, "utf8"));
} catch {
  console.warn(`[signguard] No TideCloak adapter at ${adapterPath}. Run tidecloak/bootstrap.py first.`);
}

// `frame-src *` because the Tide enclave and ORKs are framed from origins chosen at login time.
// No frame-ancestors: the enclave frames this origin for silent SSO and approvals.
const appHeaders = { "Content-Security-Policy": "frame-src 'self' *" };
const api = { "/api": { target: process.env.SIGNGUARD_API ?? "http://127.0.0.1:3000", changeOrigin: false } };

export default defineConfig({
  plugins: [vue(), tideDpopPlugin({ config: adapter })],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "virtual:tidecloak-adapter": adapterPath,
    },
  },
  server: { port: 5173, strictPort: true, headers: appHeaders, proxy: api, fs: { allow: [".", "..", "../.."] } },
  preview: { port: 4173, strictPort: true, headers: appHeaders, proxy: api },
  build: { target: "es2022", sourcemap: true },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    alias: { "virtual:tidecloak-adapter": fileURLToPath(new URL("./src/test/adapter.fixture.json", import.meta.url)) },
  },
} as Parameters<typeof defineConfig>[0]);
