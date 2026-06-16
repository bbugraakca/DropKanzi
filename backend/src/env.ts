export type EnvCheck = {
  databaseUrl: string;
  redisUrl: string;
  missing: string[];
};

export function checkEnv(): EnvCheck {
  const databaseUrl = (process.env.DATABASE_URL || "").trim();
  const redisUrl = (process.env.REDIS_URL || "").trim();
  const missing: string[] = [];
  if (!databaseUrl) missing.push("DATABASE_URL");
  if (!redisUrl) missing.push("REDIS_URL");
  return { databaseUrl, redisUrl, missing };
}

/** Log clear warnings at boot; do not exit (Redis may reconnect later). */
export function logEnvWarnings(): void {
  const { missing } = checkEnv();
  for (const key of missing) {
    console.warn(`[env] ${key} is not set — related features will fail until configured`);
  }
}
