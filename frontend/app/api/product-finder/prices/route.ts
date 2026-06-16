import { proxyPostToBackend } from "@/lib/proxyToBackend";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRICES_TIMEOUT_MS = 900_000;

export async function POST(req: Request) {
  return proxyPostToBackend("/product-finder/prices", req, PRICES_TIMEOUT_MS);
}
