/** Backend API base URL — browser vs Next server (Docker). */

export function serverBackendApiBase(): string {
  const raw =
    process.env.BACKEND_INTERNAL_URL ||
    process.env.BACKEND_URL ||
    "http://localhost:3001/api";
  return raw.replace(/\/$/, "");
}

/** Browser: same-origin /api rewrite in Docker, or direct backend when NEXT_PUBLIC_API_URL set. */
export function browserApiBase(): string {
  if (typeof window === "undefined") {
    return serverBackendApiBase();
  }
  const pub = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (pub) {
    // Windows: localhost often resolves to ::1 and hits wslrelay instead of Docker.
    return pub.replace(/\/$/, "").replace("://localhost", "://127.0.0.1");
  }
  return "/api";
}

/** Long scans (analyze/prices) — bypass Next.js proxy to avoid 5–10 min idle timeouts. */
export function browserDirectBackendBase(): string {
  if (typeof window === "undefined") {
    return serverBackendApiBase();
  }
  const pub = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (pub) {
    return pub.replace(/\/$/, "").replace("://localhost", "://127.0.0.1");
  }
  return "http://127.0.0.1:3001/api";
}

/** Saved/Reserved library — always same-origin /api proxy (reliable on Windows/Docker). */
export function browserLibraryApiBase(): string {
  if (typeof window === "undefined") {
    return serverBackendApiBase();
  }
  return "/api";
}
