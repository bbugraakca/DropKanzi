import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { checkEnv, logEnvWarnings } from "../src/env";

describe("checkEnv", () => {
  const origDb = process.env.DATABASE_URL;
  const origRedis = process.env.REDIS_URL;

  beforeEach(() => {
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
    if (origDb !== undefined) process.env.DATABASE_URL = origDb;
    else delete process.env.DATABASE_URL;
    if (origRedis !== undefined) process.env.REDIS_URL = origRedis;
    else delete process.env.REDIS_URL;
  });

  it("reports missing DATABASE_URL and REDIS_URL", () => {
    const result = checkEnv();
    expect(result.missing).toContain("DATABASE_URL");
    expect(result.missing).toContain("REDIS_URL");
  });

  it("logEnvWarnings does not throw", () => {
    expect(() => logEnvWarnings()).not.toThrow();
  });
});
