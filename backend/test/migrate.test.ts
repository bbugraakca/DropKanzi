import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";

const migrationUrl = process.env.MIGRATION_TEST_URL?.trim();
const useDocker = process.env.MIGRATION_TEST_DOCKER === "1";

describe("prisma migrate deploy", () => {
  it.skipIf(!migrationUrl && !useDocker)(
    "applies all migrations on a fresh database without error",
    () => {
      if (useDocker) {
        execSync(
          'docker exec dropkanzi-postgres-1 psql -U admin -d postgres -c "DROP DATABASE IF EXISTS pricehawk_migrate_test WITH (FORCE);"',
          { stdio: "pipe" }
        );
        execSync(
          'docker exec dropkanzi-postgres-1 psql -U admin -d postgres -c "CREATE DATABASE pricehawk_migrate_test;"',
          { stdio: "pipe" }
        );
        const out = execSync(
          "docker exec -e DATABASE_URL=postgresql://admin:secret123@postgres:5432/pricehawk_migrate_test dropkanzi-backend-1 npx prisma migrate deploy",
          { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }
        );
        expect(out).toMatch(/successfully applied/i);
        return;
      }

      const cwd = path.join(__dirname, "..");
      const out = execSync("npx prisma migrate deploy", {
        cwd,
        env: { ...process.env, DATABASE_URL: migrationUrl },
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      expect(out).toMatch(/successfully applied|No pending migrations/i);
    },
    120_000
  );
});
