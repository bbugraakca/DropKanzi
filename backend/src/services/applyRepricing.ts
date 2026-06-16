import { prisma } from "./db";
import { reviseListingOnEbay } from "./ebayListing";
import { buildListingFromStoreSettings } from "./listingPricing";

export type ApplyRepricingRow = {
  asin: string;
  listingId: string;
  oldPrice: number;
  newPrice: number;
  status: "updated" | "skipped" | "failed";
  message?: string;
};

export type ApplyRepricingResult = {
  total: number;
  updated: number;
  skipped: number;
  failed: number;
  rows: ApplyRepricingRow[];
};

export async function applyRepricingToStore(
  storeId: string
): Promise<ApplyRepricingResult> {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) throw new Error("Store not found");

  const settings = (store.settings as Record<string, unknown> | null) || {};
  const repricing = (settings.repricingSettings || settings.salesCount) as
    | { allowOOS?: boolean }
    | undefined;
  const allowOOS = repricing?.allowOOS !== false;

  const listings = await prisma.listing.findMany({
    where: { storeId },
    include: { product: true },
    orderBy: { updatedAt: "desc" },
  });

  const rows: ApplyRepricingRow[] = [];
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const listing of listings) {
    const product = listing.product;
    if (!product) {
      skipped++;
      rows.push({
        asin: listing.asin,
        listingId: listing.id,
        oldPrice: listing.price,
        newPrice: listing.price,
        status: "skipped",
        message: "No product data",
      });
      continue;
    }

    if (!product.isInStock && !allowOOS) {
      skipped++;
      rows.push({
        asin: listing.asin,
        listingId: listing.id,
        oldPrice: listing.price,
        newPrice: listing.price,
        status: "skipped",
        message: "Out of stock (Allow OOS off)",
      });
      continue;
    }

    const draft = buildListingFromStoreSettings(settings, product);
    if (draft.price <= 0) {
      skipped++;
      rows.push({
        asin: listing.asin,
        listingId: listing.id,
        oldPrice: listing.price,
        newPrice: listing.price,
        status: "skipped",
        message: "No Amazon price or range repricing blocked",
      });
      continue;
    }

    const oldPrice = listing.price;
    const newPrice = draft.price;
    const unchanged =
      Math.abs(oldPrice - newPrice) < 0.005 &&
      listing.title === draft.title &&
      listing.quantity === draft.quantity;

    if (unchanged) {
      skipped++;
      rows.push({
        asin: listing.asin,
        listingId: listing.id,
        oldPrice,
        newPrice,
        status: "skipped",
        message: "Already at calculated price",
      });
      continue;
    }

    try {
      await prisma.listing.update({
        where: { id: listing.id },
        data: {
          price: newPrice,
          title: draft.title,
          quantity: draft.quantity,
          condition: draft.condition,
        },
      });

      const isLive =
        listing.status === "active" || !!listing.ebayListingId?.trim();

      if (isLive) {
        await reviseListingOnEbay(storeId, {
          sku: listing.asin,
          title: draft.title,
          description: draft.description,
          price: newPrice,
          quantity: draft.quantity,
          condition: draft.condition,
          imageUrls: product.images || [],
        });
      }

      updated++;
      rows.push({
        asin: listing.asin,
        listingId: listing.id,
        oldPrice,
        newPrice,
        status: "updated",
      });
    } catch (err) {
      failed++;
      rows.push({
        asin: listing.asin,
        listingId: listing.id,
        oldPrice,
        newPrice,
        status: "failed",
        message: err instanceof Error ? err.message : "Update failed",
      });
    }
  }

  return {
    total: listings.length,
    updated,
    skipped,
    failed,
    rows,
  };
}
