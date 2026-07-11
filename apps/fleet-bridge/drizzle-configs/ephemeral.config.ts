import path from "path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "drizzle-kit";

// The ephemeral schema tests migrate against: deleted and regenerated from an empty
// database before every test run (see tests/setup.ts).
const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export default defineConfig({
  schema: path.join(appDir, "src/db/schema.ts"),
  dialect: "sqlite",
  out: path.join(appDir, "drizzle/ephemeral"),
});
