import { serverBackendApiBase } from "./backendUrl";

/** Server-side proxy with long timeout (analyze can run 15–30+ min). */
export async function proxyPostToBackend(
  apiPath: string,
  req: Request,
  timeoutMs: number
): Promise<Response> {
  const base = serverBackendApiBase();
  const path = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  const body = await req.text();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: {
        "Content-Type": res.headers.get("Content-Type") || "application/json",
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = /abort/i.test(msg);
    return Response.json(
      {
        error: isTimeout
          ? "Analysis timed out at the proxy — retry or use shorter date window."
          : `Backend unreachable: ${msg}`,
      },
      { status: isTimeout ? 504 : 502 }
    );
  } finally {
    clearTimeout(timer);
  }
}
