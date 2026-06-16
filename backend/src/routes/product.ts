import { Router } from "express";
import { prisma } from "../services/db";
import {
  extractAsin,
  refreshProductPrice,
  searchProduct,
} from "../services/productService";

export const productRouter = Router();

productRouter.post("/search", async (req, res) => {
  try {
    const { asin } = req.body;
    if (!asin || typeof asin !== "string") {
      return res.status(400).json({ error: "ASIN is required" });
    }

    const product = await searchProduct(asin);
    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }
    return res.json(product);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[${new Date().toISOString()}] POST /product/search`, message);
    const status = message.includes("Invalid ASIN") ? 400 : 500;
    return res.status(status).json({ error: message });
  }
});

productRouter.post("/:asin/price-check", async (req, res) => {
  try {
    const normalized = extractAsin(req.params.asin);
    if (!normalized) {
      return res.status(400).json({ error: "Invalid ASIN" });
    }

    const result = await refreshProductPrice(normalized);
    return res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(
      `[${new Date().toISOString()}] POST /product/:asin/price-check`,
      message
    );
    const status =
      message.includes("Invalid") || message.includes("Gecersiz") ? 400 : 502;
    return res.status(status).json({ error: message });
  }
});

productRouter.get("/:asin", async (req, res) => {
  try {
    const normalized = extractAsin(req.params.asin);
    if (!normalized) {
      return res.status(400).json({ error: "Invalid ASIN" });
    }

    const product = await prisma.product.findUnique({
      where: { asin: normalized },
      include: {
        priceHistory: { orderBy: { scrapedAt: "desc" }, take: 30 },
      },
    });

    if (!product) {
      return res.status(404).json({ error: "Product not found" });
    }
    return res.json(product);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[${new Date().toISOString()}] GET /product/:asin`, message);
    return res.status(500).json({ error: message });
  }
});
