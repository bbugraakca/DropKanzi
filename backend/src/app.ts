import "express-async-errors";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { productRouter } from "./routes/product";
import { bulkRouter } from "./routes/bulk";
import { jobsRouter } from "./routes/jobs";
import { productsRouter } from "./routes/products";
import { storesRouter } from "./routes/stores";
import { authEbayRouter } from "./routes/authEbay";
import { productFinderRouter } from "./routes/productFinder";
import { pfScanRouter } from "./routes/pfScan";
import { metricsRouter } from "./routes/metrics";
import { withTenant } from "./services/tenant";

export function createApp() {
  const app = express();

  const corsOrigins = new Set([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3001",
  ]);
  if (process.env.FRONTEND_URL) corsOrigins.add(process.env.FRONTEND_URL.replace(/\/$/, ""));
  if (process.env.CORS_ORIGIN) corsOrigins.add(process.env.CORS_ORIGIN.replace(/\/$/, ""));

  app.use(
    cors({
      origin: [...corsOrigins],
      credentials: true,
    })
  );
  app.use(express.json({ limit: "50mb" }));
  app.use(withTenant);

  app.use("/api/product", productRouter);
  app.use("/api/bulk", bulkRouter);
  app.use("/api/jobs", jobsRouter);
  app.use("/api/products", productsRouter);
  app.use("/api/stores", storesRouter);
  app.use("/api/auth", authEbayRouter);
  app.use("/api/product-finder", productFinderRouter);
  app.use("/api/pf-scan", pfScanRouter);
  app.use("/api/product-finder", pfScanRouter);
  app.use("/api/metrics", metricsRouter);

  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (err instanceof SyntaxError && "body" in (err as SyntaxError & { body?: unknown })) {
      return res.status(400).json({ error: "Invalid JSON request body" });
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error("[api]", message);
    res.status(500).json({ error: message || "Internal server error" });
  });

  return app;
}
