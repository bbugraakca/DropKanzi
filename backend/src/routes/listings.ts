import { Router } from "express";
import { prisma } from "../services/db";
import { applyRepricingToStore } from "../services/applyRepricing";
import { publishListingToEbay } from "../services/ebayListing";
import { buildListingFromStoreSettings } from "../services/listingPricing";
import { extractAsin } from "../services/productService";

export const listingsRouter = Router({ mergeParams: true });

type ListingParams = { storeId?: string };

// POST /api/stores/:storeId/listings/calculate — preview price with all store settings
listingsRouter.post("/calculate", async (req, res) => {
  try {
    const storeId = String((req.params as ListingParams).storeId || "");
    const { asin } = req.body as { asin?: string };
    const normalized = extractAsin(String(asin || ""));
    if (!normalized) return res.status(400).json({ error: "Invalid ASIN" });

    const store = await prisma.store.findUnique({ where: { id: storeId } });
    if (!store) return res.status(404).json({ error: "Store not found" });

    const product = await prisma.product.findUnique({ where: { asin: normalized } });
    if (!product) return res.status(404).json({ error: "Product not found" });

    const settings = (store.settings as Record<string, unknown> | null) || {};
    const draft = buildListingFromStoreSettings(settings, product);

    return res.json(draft);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

// POST /api/stores/:storeId/listings
listingsRouter.post("/", async (req, res) => {
  try {
    const storeId = String((req.params as ListingParams).storeId || "");
    if (!storeId) return res.status(400).json({ error: "storeId is required" });
    const {
      asin,
      title,
      price,
      quantity,
      condition,
      paymentPolicyId,
      returnPolicyId,
      fulfillmentPolicyId,
      publish,
      categoryId,
      manualPrice,
    } = req.body as Record<string, unknown>;

    const normalized = extractAsin(String(asin || ""));
    if (!normalized) return res.status(400).json({ error: "Invalid ASIN" });

    const store = await prisma.store.findUnique({ where: { id: storeId } });
    if (!store) return res.status(404).json({ error: "Store not found" });

    const product = await prisma.product.findUnique({ where: { asin: normalized } });
    if (!product)
      return res
        .status(404)
        .json({ error: "Product not found in DB. Search it first." });

    const policyIds = {
      payment: typeof paymentPolicyId === "string" ? paymentPolicyId : "",
      return: typeof returnPolicyId === "string" ? returnPolicyId : "",
      fulfillment: typeof fulfillmentPolicyId === "string" ? fulfillmentPolicyId : "",
    };
    if (!policyIds.payment || !policyIds.return || !policyIds.fulfillment) {
      return res.status(400).json({
        error: "paymentPolicyId, returnPolicyId, and fulfillmentPolicyId are required",
      });
    }

    const settings = (store.settings as Record<string, unknown> | null) || {};
    const draft = buildListingFromStoreSettings(settings, product, {
      title: typeof title === "string" ? title : undefined,
      price: typeof price === "number" ? price : undefined,
      quantity: typeof quantity === "number" ? quantity : undefined,
      condition: typeof condition === "string" ? condition : undefined,
      manualPrice: manualPrice === true,
    });

    if (draft.price <= 0) {
      return res.status(400).json({
        error: "Could not calculate price. Missing Amazon source price or check Range Repricing.",
        settingsApplied: draft.settingsApplied,
      });
    }

    const shouldPublish = publish !== false;
    const finalTitle = draft.title;
    const finalDescription = draft.description;
    const finalPrice = draft.price;
    const finalQuantity = draft.quantity;
    const finalCondition = draft.condition;
    const templateCategoryId = draft.categoryId;

    const existing = await prisma.listing.findFirst({
      where: { storeId, asin: normalized },
    });

    let listing = existing
      ? await prisma.listing.update({
          where: { id: existing.id },
          data: {
            title: finalTitle,
            price: finalPrice,
            quantity: finalQuantity,
            condition: finalCondition,
            paymentPolicyId: policyIds.payment,
            returnPolicyId: policyIds.return,
            fulfillmentPolicyId: policyIds.fulfillment,
          },
        })
      : await prisma.listing.create({
          data: {
            storeId,
            asin: normalized,
            title: finalTitle,
            price: finalPrice,
            quantity: finalQuantity,
            condition: finalCondition,
            status: "draft",
            paymentPolicyId: policyIds.payment,
            returnPolicyId: policyIds.return,
            fulfillmentPolicyId: policyIds.fulfillment,
          },
        });

    let publishError: string | undefined;
    if (shouldPublish) {
      try {
        const published = await publishListingToEbay(storeId, {
          sku: normalized,
          title: finalTitle,
          description: finalDescription,
          price: finalPrice,
          quantity: finalQuantity,
          condition: finalCondition,
          imageUrls: product.images || [],
          paymentPolicyId: policyIds.payment,
          returnPolicyId: policyIds.return,
          fulfillmentPolicyId: policyIds.fulfillment,
          categoryId:
            typeof categoryId === "string" ? categoryId : templateCategoryId,
        });

        listing = await prisma.listing.update({
          where: { id: listing.id },
          data: {
            status: "active",
            ebayListingId: published.listingId || published.offerId,
          },
        });
      } catch (err) {
        publishError =
          err instanceof Error ? err.message : "eBay publish failed";
      }
    }

    return res.json({
      listing,
      publishError,
      settingsApplied: draft.settingsApplied,
      priceBreakdown: draft.breakdown,
      applied: {
        title: finalTitle,
        price: finalPrice,
        quantity: finalQuantity,
        condition: finalCondition,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[${new Date().toISOString()}] POST listings`, message);
    return res.status(500).json({ error: message });
  }
});

// POST /api/stores/:storeId/listings/apply-repricing — recalc all listing prices from store settings
listingsRouter.post("/apply-repricing", async (req, res) => {
  try {
    const storeId = String((req.params as ListingParams).storeId || "");
    if (!storeId) return res.status(400).json({ error: "storeId is required" });

    const store = await prisma.store.findUnique({ where: { id: storeId } });
    if (!store) return res.status(404).json({ error: "Store not found" });

    const result = await applyRepricingToStore(storeId);
    return res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[${new Date().toISOString()}] POST apply-repricing`, message);
    return res.status(500).json({ error: message });
  }
});

// GET /api/stores/:storeId/listings?page=1&limit=50&q=...
listingsRouter.get("/", async (req, res) => {
  try {
    const storeId = String((req.params as ListingParams).storeId || "");
    if (!storeId) return res.status(400).json({ error: "storeId is required" });

    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10));
    const limit = Math.min(
      200,
      Math.max(10, parseInt(String(req.query.limit || "50"), 10))
    );
    const q = String(req.query.q || "")
      .trim()
      .toLowerCase();

    const where: {
      storeId: string;
      OR?: Array<
        | { asin: { contains: string; mode: "insensitive" } }
        | { title: { contains: string; mode: "insensitive" } }
      >;
    } = { storeId };

    if (q.length > 0) {
      where.OR = [
        { asin: { contains: q, mode: "insensitive" } },
        { title: { contains: q, mode: "insensitive" } },
      ];
    }

    const skip = (page - 1) * limit;

    const [listings, total] = await Promise.all([
      prisma.listing.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: { product: true },
      }),
      prisma.listing.count({ where }),
    ]);

    const pages = total > 0 ? Math.ceil(total / limit) : 1;

    return res.json({
      listings,
      total,
      page,
      pages,
      limit,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});
