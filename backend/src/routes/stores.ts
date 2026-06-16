import { Router } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../services/db";
import { exchangeCodeForTokens } from "../services/ebayOAuth";
import {
  getFulfillmentPolicies,
  getPaymentPolicies,
  getReturnPolicies,
} from "../services/ebayApi";
import { DEMO_LISTING_DEFAULTS } from "../services/ebayMock";
import { listingsRouter } from "./listings";
import { ordersRouter } from "./orders";

export const storesRouter = Router();

storesRouter.get("/", async (_req, res) => {
  try {
    const stores = await prisma.store.findMany({ orderBy: { createdAt: "desc" } });
    return res.json(stores);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

// POST /api/stores/demo { name? } — configure settings without eBay OAuth
storesRouter.post("/demo", async (req, res) => {
  try {
    const rawName = String((req.body as { name?: string })?.name || "Demo Store").trim();
    const displayName = rawName.slice(0, 80) || "Demo Store";
    const slugBase =
      displayName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "demo-store";

    let ebayUsername = slugBase.slice(0, 48);
    let n = 0;
    while (await prisma.store.findFirst({ where: { ebayUsername } })) {
      n += 1;
      ebayUsername = `${slugBase.slice(0, 40)}-${n}`;
    }

    const store = await prisma.store.create({
      data: {
        ebayUsername,
        accessToken: "demo",
        refreshToken: "",
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        country: "US",
        settings: {
          isDemo: true,
          storeDisplayName: displayName,
          listingDefaults: DEMO_LISTING_DEFAULTS,
        } as Prisma.InputJsonValue,
      },
    });

    return res.json(store);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

// POST /api/stores/connect-ebay { code, ebayUsername?, country? }
storesRouter.post("/connect-ebay", async (req, res) => {
  try {
    const { code, ebayUsername, country } = req.body as {
      code?: string;
      ebayUsername?: string;
      country?: string;
    };
    if (!code) return res.status(400).json({ error: "code is required" });

    const token = await exchangeCodeForTokens(String(code));
    const expiresAt = new Date(Date.now() + token.expires_in * 1000);
    const username = String(ebayUsername || "unknown").trim() || "unknown";
    const countryCode = String(country || "US").toUpperCase();

    const tokenData = {
      accessToken: token.access_token,
      refreshToken: token.refresh_token || "",
      expiresAt,
      country: countryCode,
    };

    const existing =
      username !== "unknown"
        ? await prisma.store.findFirst({ where: { ebayUsername: username } })
        : null;

    const store = existing
      ? await prisma.store.update({
          where: { id: existing.id },
          data: tokenData,
        })
      : await prisma.store.create({
          data: {
            ebayUsername: username,
            ...tokenData,
          },
        });

    return res.json(store);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[${new Date().toISOString()}] connect-ebay`, message);
    return res.status(500).json({ error: message });
  }
});

// POST /api/stores/settings/:key -> apply to all stores (must be before /:storeId/settings/:key)
storesRouter.post("/settings/:key", async (req, res) => {
  try {
    const key = req.params.key;
    const stores = await prisma.store.findMany();
    await Promise.all(
      stores.map(async (s) => {
        const current = (s.settings as Record<string, unknown> | null) || {};
        return prisma.store.update({
          where: { id: s.id },
          data: {
            settings: { ...current, [key]: req.body } as Prisma.InputJsonValue,
          },
        });
      })
    );
    return res.json({ ok: true, count: stores.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

storesRouter.delete("/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const store = await prisma.store.findUnique({ where: { id } });
    if (!store) return res.status(404).json({ error: "Store not found" });

    await prisma.$transaction([
      prisma.order.deleteMany({ where: { storeId: id } }),
      prisma.listing.deleteMany({ where: { storeId: id } }),
      prisma.store.delete({ where: { id } }),
    ]);
    return res.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

storesRouter.get("/:storeId/ebay-policies/payment", async (req, res) => {
  try {
    const data = await getPaymentPolicies(req.params.storeId);
    return res.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

storesRouter.get("/:storeId/ebay-policies/return", async (req, res) => {
  try {
    const data = await getReturnPolicies(req.params.storeId);
    return res.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

storesRouter.get("/:storeId/ebay-policies/fulfillment", async (req, res) => {
  try {
    const data = await getFulfillmentPolicies(req.params.storeId);
    return res.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

storesRouter.use("/:storeId/listings", listingsRouter);
storesRouter.use("/:storeId/orders", ordersRouter);

// GET /api/stores/:storeId/settings
storesRouter.get("/:storeId/settings", async (req, res) => {
  try {
    const store = await prisma.store.findUnique({ where: { id: req.params.storeId } });
    if (!store) return res.status(404).json({ error: "Store not found" });
    return res.json({ id: store.id, settings: store.settings || {} });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

async function upsertSettings(storeId: string, patch: Record<string, unknown>) {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) return null;
  const current = (store.settings as Record<string, unknown> | null) || {};
  const next = { ...current, ...patch };
  return prisma.store.update({
    where: { id: storeId },
    data: { settings: next as Prisma.InputJsonValue },
  });
}

// POST /api/stores/:storeId/settings/<key> { ... }  -> Store.settings[key] = body
storesRouter.post("/:storeId/settings/:key", async (req, res) => {
  try {
    const { storeId, key } = req.params;
    if (storeId === "settings") {
      return res.status(400).json({
        error: "Use POST /api/stores/settings/:key for save-all",
      });
    }
    const store = await upsertSettings(storeId, { [key]: req.body });
    if (!store) return res.status(404).json({ error: "Store not found" });
    return res.json({ ok: true, settings: store.settings || {} });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});
