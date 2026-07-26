import { defineConfig } from "tsup";

export default defineConfig({
  // Transpile-only (no bundling): domain handlers are lazily loaded via
  // dynamic import at runtime (src/domains/index.ts), so every source file
  // must map 1:1 onto dist/ with its "./x.js" specifiers left untouched.
  // Bundling would try to resolve the domain modules at build time instead.
  entry: ["src/**/*.ts", "!src/__tests__/**", "!src/**/*.test.ts"],
  format: ["esm"],
  bundle: false,
  splitting: false,
  clean: true,
  sourcemap: true,
  platform: "node",
  target: "node20",
});
