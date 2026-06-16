import { proxyPostToBackend } from "@/lib/proxyToBackend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ANALYZE_TIMEOUT_MS = 1_800_000;

export async function POST(req: Request) {
  return proxyPostToBackend("/product-finder/analyze", req, ANALYZE_TIMEOUT_MS);
}
