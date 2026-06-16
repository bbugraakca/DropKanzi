import { Router } from "express";
import { prisma } from "../services/db";
import { getOrder, getOrders } from "../services/ebayApi";
import { extractAsin } from "../services/productService";

export const ordersRouter = Router({ mergeParams: true });

function mapInternalStatus(input: {
  sourceOrderUrl?: string | null;
  tracking?: string | null;
  delivered?: boolean;
}): string {
  if (input.delivered) return "delivered";
  if (input.tracking) return "tracking";
  if (input.sourceOrderUrl) return "ordered";
  return "received_not_ordered";
}

function toNumber(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// POST /api/stores/:storeId/orders/sync
ordersRouter.post("/sync", async (req, res) => {
  try {
    const storeId = String((req.params as any).storeId || "");
    if (!storeId) return res.status(400).json({ error: "storeId is required" });

    const store = await prisma.store.findUnique({ where: { id: storeId } });
    if (!store) return res.status(404).json({ error: "Store not found" });

    const limit = toNumber((req.body as any)?.limit) || 50;
    const offset = toNumber((req.body as any)?.offset) || 0;

    const data = await getOrders(storeId, limit, offset);
    const orders = Array.isArray(data?.orders) ? data.orders : [];

    const upserts: any[] = [];

    for (const o of orders) {
      const ebayOrderId = String(o?.orderId || "");
      if (!ebayOrderId) continue;

      // Fetch full order details for tracking/fulfillments when available.
      let full: any = null;
      try {
        full = await getOrder(storeId, ebayOrderId);
      } catch {
        full = o;
      }

      const buyer = String(full?.buyer?.username || full?.buyer?.buyerRegistrationAddress?.fullName || "")
        .trim() || null;

      const pricing = full?.pricingSummary;
      const total = toNumber(pricing?.total?.value);

      const lineItems = Array.isArray(full?.lineItems) ? full.lineItems : [];
      if (lineItems.length === 0) {
        // Create a single row even if line items missing
        upserts.push({
          where: {
            storeId_ebayOrderId_lineItemId: {
              storeId,
              ebayOrderId,
              lineItemId: "NO_LINE_ITEM",
            },
          },
          create: {
            storeId,
            ebayOrderId,
            lineItemId: "NO_LINE_ITEM",
            asin: null,
            title: String(full?.orderId || "Order"),
            image: null,
            buyer,
            qty: 1,
            paidAmount: total,
            price: total,
            raw: full,
            status: mapInternalStatus({}),
          },
          update: {
            buyer,
            paidAmount: total,
            price: total,
            raw: full,
          },
        });
        continue;
      }

      for (const li of lineItems) {
        const lineItemId =
          String(li?.lineItemId || li?.legacyItemId || li?.itemId || "").trim() ||
          "NO_LINE_ITEM";
        const qty = Number(li?.quantity || 1) || 1;

        const title = String(li?.title || li?.item?.title || "Item");
        const image =
          String(li?.image?.imageUrl || li?.item?.image?.imageUrl || "") || null;

        const itemId = String(li?.legacyItemId || li?.itemId || "") || null;
        const targetUrl = itemId ? `https://www.ebay.com/itm/${itemId}` : null;

        const maybeAsin =
          extractAsin(String(li?.sku || "")) ||
          extractAsin(String(li?.item?.sku || "")) ||
          null;

        const sourceUrl = maybeAsin ? `https://www.amazon.com/dp/${maybeAsin}` : null;

        const lineItemCost = toNumber(li?.lineItemCost?.value);
        const lineItemTotal = toNumber(li?.lineItemCost?.value);

        let amazonPrice: number | null = null;
        if (maybeAsin) {
          const product = await prisma.product.findUnique({ where: { asin: maybeAsin } });
          amazonPrice = product?.price ?? null;
        }

        const price = lineItemTotal ?? lineItemCost ?? total;
        const profit =
          price != null && amazonPrice != null ? price - amazonPrice : null;

        const deliverStatus = String(full?.orderFulfillmentStatus || "").toUpperCase();
        const delivered =
          deliverStatus === "FULFILLED" ||
          deliverStatus === "DELIVERED" ||
          deliverStatus === "COMPLETED";

        // Tracking extraction best-effort
        const fulfillments = Array.isArray(full?.fulfillments) ? full.fulfillments : [];
        const firstTracking =
          fulfillments?.[0]?.shipmentTrackingNumber ||
          fulfillments?.[0]?.trackingNumber ||
          null;
        const firstCarrier =
          fulfillments?.[0]?.shippingCarrierCode ||
          fulfillments?.[0]?.carrierCode ||
          null;

        const existing = await prisma.order.findUnique({
          where: { storeId_ebayOrderId_lineItemId: { storeId, ebayOrderId, lineItemId } },
        });

        const status = mapInternalStatus({
          sourceOrderUrl: existing?.sourceOrderUrl || null,
          tracking: existing?.tracking || firstTracking,
          delivered,
        });

        upserts.push({
          where: { storeId_ebayOrderId_lineItemId: { storeId, ebayOrderId, lineItemId } },
          create: {
            storeId,
            ebayOrderId,
            lineItemId,
            asin: maybeAsin,
            title,
            image,
            status,
            targetUrl,
            buyer,
            qty,
            paidAmount: total,
            sourceUrl,
            amazonPrice,
            price,
            profit,
            carrier: firstCarrier,
            tracking: firstTracking,
            raw: full,
          },
          update: {
            asin: maybeAsin,
            title,
            image,
            targetUrl,
            buyer,
            qty,
            paidAmount: total,
            sourceUrl,
            amazonPrice,
            price,
            profit,
            carrier: existing?.carrier || firstCarrier,
            tracking: existing?.tracking || firstTracking,
            raw: full,
            status,
          },
        });
      }
    }

    const results = [];
    for (const u of upserts) {
      results.push(await prisma.order.upsert(u));
    }

    return res.json({ ok: true, upserted: results.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[${new Date().toISOString()}] POST orders/sync`, message);
    return res.status(500).json({ error: message });
  }
});

// GET /api/stores/:storeId/orders
ordersRouter.get("/", async (req, res) => {
  try {
    const storeId = String((req.params as any).storeId || "");
    if (!storeId) return res.status(400).json({ error: "storeId is required" });
    const items = await prisma.order.findMany({
      where: { storeId },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });
    return res.json(items);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

// POST /api/stores/:storeId/orders/:id -> patch notes/sourceOrderUrl/carrier/tracking/status
ordersRouter.post("/:id", async (req, res) => {
  try {
    const storeId = String((req.params as any).storeId || "");
    const id = String(req.params.id || "");
    if (!storeId) return res.status(400).json({ error: "storeId is required" });
    if (!id) return res.status(400).json({ error: "id is required" });

    const patch = req.body as any;
    const allowed: any = {};
    if (typeof patch.notes === "string") allowed.notes = patch.notes;
    if (typeof patch.sourceOrderUrl === "string") allowed.sourceOrderUrl = patch.sourceOrderUrl;
    if (typeof patch.carrier === "string") allowed.carrier = patch.carrier;
    if (typeof patch.tracking === "string") allowed.tracking = patch.tracking;
    if (typeof patch.status === "string") allowed.status = patch.status;

    const existing = await prisma.order.findFirst({ where: { id, storeId } });
    if (!existing) return res.status(404).json({ error: "Order not found" });

    const nextStatus =
      typeof allowed.status === "string"
        ? allowed.status
        : mapInternalStatus({
            sourceOrderUrl: allowed.sourceOrderUrl ?? existing.sourceOrderUrl,
            tracking: allowed.tracking ?? existing.tracking,
            delivered: existing.status === "delivered",
          });

    const updated = await prisma.order.update({
      where: { id },
      data: { ...allowed, status: nextStatus },
    });
    return res.json(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return res.status(500).json({ error: message });
  }
});

