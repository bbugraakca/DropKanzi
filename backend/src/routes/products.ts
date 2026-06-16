import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../services/db";

export const productsRouter = Router();

productsRouter.get("/", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
    const filter = String(req.query.filter || "all");
    const sort = String(req.query.sort || "updated");
    const asinsParam = req.query.asins;

    const where: Prisma.ProductWhereInput = {};
    let asinFilterCount = 0;

    if (asinsParam && typeof asinsParam === "string") {
      const asinList = asinsParam
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter((s) => s.length === 10);
      asinFilterCount = asinList.length;
      if (asinList.length > 0) {
        where.asin = { in: asinList };
      }
    }

    const limit = Math.min(
      500,
      Math.max(
        1,
        parseInt(
          String(req.query.limit || (asinFilterCount > 0 ? asinFilterCount : 20)),
          10
        )
      )
    );
    if (filter === "instock") where.isInStock = true;
    if (filter === "amazon") where.isAmazonFulfilled = true;

    let orderBy: Record<string, "asc" | "desc"> = { updatedAt: "desc" };
    if (sort === "price") orderBy = { price: "asc" };

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy,
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.product.count({ where }),
    ]);

    const pages = Math.ceil(total / limit) || 1;

    return res.json({ products, total, page, pages });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[${new Date().toISOString()}] GET /products`, message);
    return res.status(500).json({ error: message });
  }
});
