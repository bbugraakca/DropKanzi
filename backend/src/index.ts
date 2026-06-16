import "dotenv/config";
import cors from "cors";
import express from "express";
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
import { startPfProgressSubscriber } from "./services/progressSubscriber";

const app = express();
const PORT = parseInt(
  process.env.PORT || process.env.BACKEND_PORT || "3001",
  10
);

const corsOrigins = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3001",
]);
if (process.env.FRONTEND_URL) corsOrigins.add(process.env.FRONTEND_URL.replace(/\/$/, ""));
// Allow LAN access (e.g. http://192.168.x.x:3000) when developing on another device.
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

const server = app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Backend listening on port ${PORT}`);
});

startPfProgressSubscriber();

// Don't let the HTTP server abort slow product-finder requests mid-flight.
server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 7_200_000;
server.timeout = 0;
