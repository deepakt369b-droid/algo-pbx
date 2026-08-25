import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
  },
  resolve: {
    // Mirrors tsconfig.json's "@/*": ["./src/*"] — without this, any
    // test file that imports a module using the @/ alias (directly or
    // transitively, e.g. src/lib/registration.ts imports "@/lib/db")
    // fails to resolve under vitest even though it type-checks and
    // builds fine under Next.js, which handles the alias itself.
    alias: {
      "@": path.resolve(dirname, "./src"),
    },
  },
});
