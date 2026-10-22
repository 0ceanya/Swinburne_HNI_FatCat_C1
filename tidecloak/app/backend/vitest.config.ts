import { defineConfig } from "vitest/config";

export default defineConfig({
  // @tideorg/js ships sourcemaps without sources; the warnings are noise.
  logLevel: "error",
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // @tideorg/js ships extensionless ESM imports that only a bundler resolves. Inlining it lets the
    // tests cross-check our own byte codec against the real library, byte for byte.
    server: { deps: { inline: ["@tideorg/js"] } },
  },
});
