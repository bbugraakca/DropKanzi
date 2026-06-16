"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Layout } from "@/components/layout/Layout";
import { AddProductModal } from "@/components/products/AddProductModal";
import { SellerSearch } from "@/components/product-finder/SellerSearch";
import { SellersWatchlistPanel } from "@/components/product-finder/SellersWatchlistPanel";
import { FoundProductsPanel } from "@/components/product-finder/FoundProductsPanel";
import { ActiveListingsPanel } from "@/components/product-finder/ActiveListingsPanel";
import { QueuePanel, type QueueItem } from "@/components/product-finder/QueuePanel";
import { SavedProductsPanel } from "@/components/product-finder/SavedProductsPanel";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Button } from "@/components/ui/Button";
import {
  postPfScan,
  getPfScanJobs,
  cancelPfScan,
  type PfScanJob,
  getStoreSettings,
  importFoundFromAnalysis,
  removeFoundProducts,
  clearFoundProducts,
  fetchFoundStats,
  fetchLibraryProducts,
  syncLibraryProducts,
  type LibraryBucket,
  mergeLibraryProducts,
  moveLibraryProducts,
  removeLibraryProducts,
  clearLibraryProducts,
  dedupeLibraryProducts,
  dedupeFoundProducts,
  fetchActiveStats,
  removeActiveProducts,
  restoreLibraryToFound,
  fetchArchiveStatus,
  restoreArchiveSnapshot,
  type PfArchiveSource,
  type ProductFinderListing,
} from "@/lib/api";
import {
  enrichListingsProfit,
} from "@/lib/productFinderProfit";
import { parseEbaySellerInput } from "@/lib/parseEbaySellerInput";
import {
  SAVED_KEY,
  RESERVED_KEY,
  listingKey,
  allListingKeys,
  foundRemoveKeys,
  activeRemoveKeys,
  readDeletedFoundKeys,
  writeDeletedFoundKeys,
  dedupeSavedByListingKey,
  mergeListing,
  normalizeAsin,
  writeSavedLocal,
  scheduleWriteSavedLocal,
  writeReservedLocal,
  scheduleWriteReservedLocal,
  archiveSellerScan,
  rememberSellerSearches,
  uniqueSellerHistory,
  WEEKLY_REFRESH_DAYS,
  type StoredSellerSearch,
} from "@/lib/productFinderStorage";
import { useAppStore } from "@/lib/store/appStore";
import { cn } from "@/lib/utils";

const PF_TAB_STORAGE_KEY = "pf_active_tab";

type PfTab = "queue" | "sellers" | "found" | "active" | "saved" | "reserved";

type ConfirmAction =
  | { kind: "clearFound"; count: number }
  | { kind: "clearSaved"; count: number }
  | { kind: "clearReserved"; count: number }
  | { kind: "returnToFound"; listings: ProductFinderListing[] }
  | { kind: "restoreArchive"; source: PfArchiveSource; count: number };

function normalizeSellerName(raw: string): string {
  return parseEbaySellerInput(raw).seller;
}

function sellerAnalyzeInput(raw: string): string {
  return parseEbaySellerInput(raw).apiInput;
}

function isValidSellerName(seller: string): boolean {
  const s = normalizeSellerName(seller);
  return s.length >= 2 && !/^\d+$/.test(s);
}

function readSavedLocal(): ProductFinderListing[] {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readReservedLocal(): ProductFinderListing[] {
  try {
    const raw = localStorage.getItem(RESERVED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const LIBRARY_LOAD_RETRIES = 3;
const LIBRARY_LOAD_RETRY_MS = 1500;

async function fetchLibraryWithRetry(
  bucket: "saved" | "reserved"
): Promise<{ listings: ProductFinderListing[]; fromServer: boolean }> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < LIBRARY_LOAD_RETRIES; attempt++) {
    try {
      const res = await fetchLibraryProducts(bucket);
      return { listings: res.listings ?? [], fromServer: true };
    } catch (err) {
      lastErr = err;
      if (attempt < LIBRARY_LOAD_RETRIES - 1) {
        await new Promise((r) => setTimeout(r, LIBRARY_LOAD_RETRY_MS * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

/** Merge browser-only rows into server when local cache has more than DB. */
async function reconcileLibraryBucket(
  bucket: "saved" | "reserved",
  serverListings: ProductFinderListing[],
  localListings: ProductFinderListing[]
): Promise<ProductFinderListing[]> {
  let merged = dedupeSavedByListingKey(serverListings);

  if (merged.length === 0 && localListings.length > 0) {
    await syncLibraryProducts(bucket, localListings, { force: true });
    return dedupeSavedByListingKey(localListings);
  }

  const serverKeys = new Set(merged.map((l) => listingKey(l)));
  const localOnly = localListings.filter((l) => !serverKeys.has(listingKey(l)));
  if (localOnly.length > 0) {
    await mergeLibraryProducts(bucket, localOnly);
    merged = dedupeSavedByListingKey([...merged, ...localOnly]);
  }

  return merged;
}

export default function ProductFinderPage() {
  const storeId = useAppStore((s) => s.activeStoreId);
  const bumpListingsVersion = useAppStore((s) => s.bumpListingsVersion);

  const [queueView, setQueueView] = useState<QueueItem[]>([]);
  const queueMapRef = useRef<Map<string, QueueItem>>(new Map());
  const [foundTotal, setFoundTotal] = useState(0);
  const [foundRefreshKey, setFoundRefreshKey] = useState(0);
  const [activeTotal, setActiveTotal] = useState(0);
  const [activeRefreshKey, setActiveRefreshKey] = useState(0);
  const [focusActiveSeller, setFocusActiveSeller] = useState<string | null>(null);
  const [scanningActiveSeller] = useState<string | null>(null);
  const tabRef = useRef<PfTab>("found");
  const pendingFoundRefreshRef = useRef(false);
  const pendingActiveRefreshRef = useRef(false);

  const foundStatsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshFoundGlobalStats = useCallback(() => {
    if (foundStatsTimerRef.current) clearTimeout(foundStatsTimerRef.current);
    foundStatsTimerRef.current = setTimeout(() => {
      foundStatsTimerRef.current = null;
      void fetchFoundStats()
        .then((s) => {
          setFoundTotal((prev) => (prev === s.total ? prev : s.total));
        })
        .catch(() => undefined);
    }, 400);
  }, []);

  const activeStatsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshActiveGlobalStats = useCallback(() => {
    if (activeStatsTimerRef.current) clearTimeout(activeStatsTimerRef.current);
    activeStatsTimerRef.current = setTimeout(() => {
      activeStatsTimerRef.current = null;
      void fetchActiveStats()
        .then((s) => {
          setActiveTotal((prev) => (prev === s.total ? prev : s.total));
        })
        .catch(() => undefined);
    }, 400);
  }, []);

  const bumpActive = useCallback(() => {
    refreshActiveGlobalStats();
    if (tabRef.current === "active") {
      setActiveRefreshKey((k) => k + 1);
    } else {
      pendingActiveRefreshRef.current = true;
    }
  }, [refreshActiveGlobalStats]);

  const bumpFound = useCallback(() => {
    refreshFoundGlobalStats();
    if (tabRef.current === "found") {
      setFoundRefreshKey((k) => k + 1);
    } else {
      pendingFoundRefreshRef.current = true;
    }
  }, [refreshFoundGlobalStats]);
  const [saved, setSaved] = useState<ProductFinderListing[]>([]);
  const [reserved, setReserved] = useState<ProductFinderListing[]>([]);
  const [tab, setTabState] = useState<PfTab>("found");
  const setTab = useCallback((next: PfTab) => {
    tabRef.current = next;
    setTabState(next);
    try {
      sessionStorage.setItem(PF_TAB_STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
    if (next === "found" && pendingFoundRefreshRef.current) {
      pendingFoundRefreshRef.current = false;
      setFoundRefreshKey((k) => k + 1);
    }
    if (next === "active" && pendingActiveRefreshRef.current) {
      pendingActiveRefreshRef.current = false;
      setActiveRefreshKey((k) => k + 1);
    }
  }, []);

  useEffect(() => {
    tabRef.current = tab;
  }, [tab]);

  useEffect(() => {
    try {
      const savedTab = sessionStorage.getItem(PF_TAB_STORAGE_KEY) as PfTab | null;
      if (
        savedTab === "queue" ||
        savedTab === "sellers" ||
        savedTab === "found" ||
        savedTab === "active" ||
        savedTab === "saved" ||
        savedTab === "reserved"
      ) {
        tabRef.current = savedTab;
        setTabState(savedTab);
      }
    } catch {
      /* ignore */
    }
  }, []);

  /** Load Saved/Reserved from PostgreSQL; migrate browser cache if DB empty. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const localSaved = dedupeSavedByListingKey(readSavedLocal());
      const localReserved = dedupeSavedByListingKey(readReservedLocal());
      let savedFromServer = false;
      let reservedFromServer = false;
      let nextSaved = localSaved;
      let nextReserved = localReserved;
      const errors: string[] = [];

      try {
        const savedRes = await fetchLibraryWithRetry("saved");
        if (cancelled) return;
        savedFromServer = savedRes.fromServer;
        try {
          nextSaved = await reconcileLibraryBucket("saved", savedRes.listings, localSaved);
        } catch {
          nextSaved = dedupeSavedByListingKey(
            savedRes.listings.length > 0 ? savedRes.listings : localSaved
          );
        }
      } catch (err) {
        errors.push(err instanceof Error ? err.message : "Saved load failed");
      }

      try {
        const reservedRes = await fetchLibraryWithRetry("reserved");
        if (cancelled) return;
        reservedFromServer = reservedRes.fromServer;
        try {
          nextReserved = await reconcileLibraryBucket(
            "reserved",
            reservedRes.listings,
            localReserved
          );
        } catch {
          nextReserved = dedupeSavedByListingKey(
            reservedRes.listings.length > 0 ? reservedRes.listings : localReserved
          );
        }
      } catch (err) {
        errors.push(err instanceof Error ? err.message : "Reserved load failed");
      }

      if (cancelled) return;

      if (!savedFromServer && !reservedFromServer) {
        setSaved(localSaved);
        setReserved(localReserved);
        savedRef.current = localSaved;
        reservedRef.current = localReserved;
        const detail = errors[0]?.slice(0, 120);
        toast.warning(
          detail
            ? `Could not load Saved/Reserved from server — using browser cache. (${detail})`
            : "Could not load Saved/Reserved from server — using browser cache."
        );
        return;
      }

      const enrichedSaved = enrichListingsProfit(nextSaved, storeSettingsRef.current);
      const enrichedReserved = enrichListingsProfit(nextReserved, storeSettingsRef.current);
      setSaved(enrichedSaved);
      setReserved(enrichedReserved);
      savedRef.current = enrichedSaved;
      reservedRef.current = enrichedReserved;
      writeSavedLocal(enrichedSaved);
      writeReservedLocal(enrichedReserved);

      if (errors.length > 0) {
        toast.message(`Loaded partial library from server (${errors.length} bucket failed).`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  const [addAsins, setAddAsins] = useState<string[] | null>(null);
  const [storeSettings, setStoreSettings] = useState<Record<string, unknown> | null>(null);
  const [pastSellersRefresh, setPastSellersRefresh] = useState(0);
  const [focusFoundSeller, setFocusFoundSeller] = useState<string | null>(null);
  const [importingSeller, setImportingSeller] = useState<string | null>(null);
  const [importingBulk, setImportingBulk] = useState(false);
  const [dedupingLibrary, setDedupingLibrary] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [archiveHint, setArchiveHint] = useState<
    Partial<Record<PfArchiveSource, { count: number; archivedAt: string | null }>>
  >({});

  const storeSettingsRef = useRef(storeSettings);
  const savedRef = useRef(saved);
  const reservedRef = useRef(reserved);
  storeSettingsRef.current = storeSettings;
  savedRef.current = saved;
  reservedRef.current = reserved;

  // Keep refs in sync on first paint (initializer already loaded localStorage).
  useEffect(() => {
    savedRef.current = saved;
  }, [saved]);

  useEffect(() => {
    reservedRef.current = reserved;
  }, [reserved]);

  const syncQueue = useCallback(() => {
    const snapshot = Array.from(queueMapRef.current.values());
    snapshot.sort((a, b) => a.id.localeCompare(b.id));
    setQueueView(snapshot);
  }, []);

  const archiveAndRemoveQueueItem = useCallback((item: QueueItem) => {
    if (item.status !== "done" && item.status !== "failed") return;
    archiveSellerScan({
      seller: item.seller,
      daysBack: item.daysBack,
      sellerInput: item.sellerInput,
      matched: item.matched,
      total: item.total,
      ebaySellerId: item.ebaySellerId,
      status: item.status,
      error: item.error,
      costUsd: item.costUsd,
      costBytes: item.costBytes,
      costRequests: item.costRequests,
      cached: item.cached,
      costStages: item.costStages,
      matchTitlesAttempted: item.matchAttempted,
      matchTitlesSkipped: item.matchSkipped,
      serpLookups: item.serpLookups,
      serpProxy: item.serpProxy,
      serpDirect: item.serpDirect,
    });
    queueMapRef.current.delete(item.id);
    setPastSellersRefresh((n) => n + 1);
  }, []);

  // Server is source of truth for queue.
  useEffect(() => {
    let stop = false;
    const refresh = async () => {
      const jobs = (await getPfScanJobs()).jobs ?? [];
      if (stop) return;
      for (const j of jobs) {
        const existing = queueMapRef.current.get(j.id);
        const summary = ((j.progress as { summary?: Record<string, unknown> } | null)?.summary ??
          {}) as Record<string, unknown>;
        const item: QueueItem = {
          id: j.id,
          seller: j.seller,
          daysBack: j.daysBack,
          scanMode: j.scanType as "sold" | "active",
          status:
            j.status === "active"
              ? "running"
              : j.status === "queued"
                ? "queued"
                : j.status === "done"
                  ? "done"
                  : "failed",
          matched: Number(summary.matched_to_amazon ?? existing?.matched ?? 0),
          total: Number(summary.total_listings ?? existing?.total ?? 0),
          costUsd: Number(summary.proxy_cost_usd ?? existing?.costUsd ?? 0),
          error: j.error ?? undefined,
          forceRefresh: j.forceRefresh || undefined,
        };
        queueMapRef.current.set(j.id, item);
      }
      syncQueue();
    };
    void refresh();
    const poll = window.setInterval(() => {
      void refresh().catch(() => undefined);
    }, 5000);
    return () => {
      stop = true;
      window.clearInterval(poll);
    };
  }, [syncQueue]);

  const deletedFoundRef = useRef(readDeletedFoundKeys());

  useEffect(() => {
    refreshFoundGlobalStats();
    refreshActiveGlobalStats();
  }, [refreshFoundGlobalStats, refreshActiveGlobalStats]);

  useEffect(() => {
    if (!storeId) {
      setStoreSettings(null);
      return;
    }
    let cancelled = false;
    getStoreSettings(storeId)
      .then((r) => {
        if (!cancelled) setStoreSettings((r.settings as Record<string, unknown>) ?? null);
      })
      .catch(() => {
        if (!cancelled) setStoreSettings(null);
      });
    return () => {
      cancelled = true;
    };
  }, [storeId]);

  // Recompute profit when store fee/VAT settings load (Saved + Reserved — no Found reload).
  useEffect(() => {
    setSaved((prev) => {
      if (prev.length === 0) return prev;
      const next = enrichListingsProfit(prev, storeSettings);
      savedRef.current = next;
      scheduleWriteSavedLocal(next);
      return next;
    });
    setReserved((prev) => {
      if (prev.length === 0) return prev;
      const next = enrichListingsProfit(prev, storeSettings);
      reservedRef.current = next;
      scheduleWriteReservedLocal(next);
      return next;
    });
  }, [storeSettings]);

  const refreshArchiveHints = useCallback(async () => {
    try {
      const [found, saved, reserved] = await Promise.all([
        fetchArchiveStatus("found"),
        fetchArchiveStatus("saved"),
        fetchArchiveStatus("reserved"),
      ]);
      setArchiveHint({
        found: { count: found.count, archivedAt: found.archivedAt },
        saved: { count: saved.count, archivedAt: saved.archivedAt },
        reserved: { count: reserved.count, archivedAt: reserved.archivedAt },
      });
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    void refreshArchiveHints();
  }, [refreshArchiveHints]);

  const syncSavedToServer = useCallback(
    async (prev: ProductFinderListing[], next: ProductFinderListing[]) => {
      const prevKeys = new Set(prev.map((l) => listingKey(l)));
      const nextKeys = new Set(next.map((l) => listingKey(l)));
      const removed = prev.filter((l) => !nextKeys.has(listingKey(l)));
      const toUpsert = next;

      if (removed.length > 0) {
        await removeLibraryProducts("saved", removed);
      }
      if (toUpsert.length > 0) {
        await mergeLibraryProducts("saved", toUpsert);
      }
    },
    []
  );

  const syncReservedToServer = useCallback(
    async (prev: ProductFinderListing[], next: ProductFinderListing[]) => {
      const prevKeys = new Set(prev.map((l) => listingKey(l)));
      const nextKeys = new Set(next.map((l) => listingKey(l)));
      const removed = prev.filter((l) => !nextKeys.has(listingKey(l)));
      const toUpsert = next;

      if (removed.length > 0) {
        await removeLibraryProducts("reserved", removed);
      }
      if (toUpsert.length > 0) {
        await mergeLibraryProducts("reserved", toUpsert);
      }
    },
    []
  );

  const persistSaved = useCallback((next: ProductFinderListing[]) => {
    const prev = savedRef.current;
    const deduped = dedupeSavedByListingKey(next);
    const enriched = enrichListingsProfit(deduped, storeSettingsRef.current);
    setSaved(enriched);
    savedRef.current = enriched;
    if (!writeSavedLocal(enriched)) {
      toast.error("Browser cache full — data is saved on server.");
    }
    void syncSavedToServer(prev, enriched).catch(() => {
      toast.error("Saved sync to server failed — use Recover backup or refresh.");
    });
  }, [syncSavedToServer]);

  const persistReserved = useCallback((next: ProductFinderListing[]) => {
    const prev = reservedRef.current;
    const deduped = dedupeSavedByListingKey(next);
    const enriched = enrichListingsProfit(deduped, storeSettingsRef.current);
    setReserved(enriched);
    reservedRef.current = enriched;
    if (!writeReservedLocal(enriched)) {
      toast.error("Browser cache full — data is saved on server.");
    }
    void syncReservedToServer(prev, enriched).catch(() => {
      toast.error("Reserved sync to server failed — use Recover backup or refresh.");
    });
  }, [syncReservedToServer]);

  const moveToSaved = useCallback(
    (
      listings: ProductFinderListing[],
      opts?: { removeFromFound?: boolean; removeFromActive?: boolean }
    ) => {
      const removeFromFound = opts?.removeFromFound !== false && opts?.removeFromActive !== true;
      const removeFromActive = opts?.removeFromActive === true;
      const withAsin = listings.filter((l) => normalizeAsin(l.amazon_asin));
      if (withAsin.length === 0) {
        toast.message("No Amazon match — cannot save.");
        return;
      }

      const enriched = enrichListingsProfit(withAsin, storeSettingsRef.current);
      const savedKeySet = new Set(savedRef.current.map((s) => listingKey(s)));
      const toAdd: ProductFinderListing[] = [];
      const toRefresh: ProductFinderListing[] = [];

      for (const l of enriched) {
        const key = listingKey(l);
        if (savedKeySet.has(key)) toRefresh.push(l);
        else toAdd.push(l);
      }

      let nextSaved = [...savedRef.current];
      if (toAdd.length > 0) {
        nextSaved = [...nextSaved, ...toAdd];
      }
      if (toRefresh.length > 0) {
        const refreshByKey = new Map(toRefresh.map((l) => [listingKey(l), l]));
        nextSaved = nextSaved.map((s) => {
          const key = listingKey(s);
          if (refreshByKey.has(key)) {
            return mergeListing(s, refreshByKey.get(key)!);
          }
          return s;
        });
      }

      persistSaved(nextSaved);

      if (removeFromFound) {
        const deleted = new Set(deletedFoundRef.current);
        for (const l of withAsin) {
          for (const k of foundRemoveKeys(l)) deleted.add(k);
        }
        deletedFoundRef.current = deleted;
        writeDeletedFoundKeys(deleted);

        const keys = Array.from(new Set(withAsin.flatMap((l) => foundRemoveKeys(l))));
        void removeFoundProducts(keys, withAsin)
          .then((r) => {
            bumpFound();
            if (r.removed === 0 && withAsin.length > 0) {
              toast.warning(
                "Saved locally but Found rows were not removed on server — refresh Found or delete manually."
              );
            }
          })
          .catch(() => {
            toast.message("Saved locally — remove from Found failed on server, retry.");
          });
      }

      if (removeFromActive) {
        void removeActiveProducts([], withAsin)
          .then((r) => {
            bumpActive();
            if (r.removed === 0 && withAsin.length > 0) {
              toast.warning(
                "Saved but Live rows were not removed on server — refresh Live or delete manually."
              );
            }
          })
          .catch(() => {
            toast.message("Saved locally — remove from Live failed on server, retry.");
          });
      }

      const savedCount = toAdd.length + toRefresh.length;
      if (removeFromActive) {
        if (toAdd.length > 0 && toRefresh.length > 0) {
          toast.success(
            `Saved ${toAdd.length} · ${toRefresh.length} already saved — removed from Live.`
          );
        } else if (toAdd.length > 0) {
          toast.success(
            toAdd.length === 1
              ? "Saved to Saved — removed from Live."
              : `Saved ${toAdd.length.toLocaleString()} to Saved — removed from Live.`
          );
        } else {
          toast.success("Already in Saved — updated & removed from Live.");
        }
      } else if (removeFromFound) {
        if (toAdd.length > 0 && toRefresh.length > 0) {
          toast.success(
            `Saved ${toAdd.length} · ${toRefresh.length} already saved — removed from Found.`
          );
        } else if (toAdd.length > 0) {
          toast.success(
            toAdd.length === 1
              ? "Moved to Saved — removed from Found."
              : `Moved ${toAdd.length} to Saved — removed from Found.`
          );
        } else {
          toast.success("Already in Saved — updated & removed from Found.");
        }
      } else if (toAdd.length > 0 && toRefresh.length > 0) {
        toast.success(`Saved ${toAdd.length} new · updated ${toRefresh.length} already in Saved.`);
      } else if (toAdd.length > 0) {
        toast.success(
          savedCount === 1 ? "Saved to Saved." : `Saved ${savedCount.toLocaleString()} to Saved.`
        );
      } else {
        toast.success("Already in Saved — updated.");
      }
    },
    [persistSaved, bumpFound, bumpActive]
  );

  const saveListing = (listing: ProductFinderListing) => {
    moveToSaved([listing]);
  };

  const saveMany = (listings: ProductFinderListing[]) => {
    moveToSaved(listings);
  };

  const saveListingFromLive = (listing: ProductFinderListing) => {
    moveToSaved([listing], { removeFromFound: false, removeFromActive: true });
  };

  const saveManyFromLive = (listings: ProductFinderListing[]) => {
    moveToSaved(listings, { removeFromFound: false, removeFromActive: true });
  };

  const deleteFromActive = useCallback(
    (toRemove: ProductFinderListing[]) => {
      if (toRemove.length === 0) return;
      const apiKeys = Array.from(new Set(toRemove.flatMap((l) => activeRemoveKeys(l))));
      void removeActiveProducts(apiKeys, toRemove)
        .then(() => bumpActive())
        .catch(() => {
          toast.message("Remove failed on server — retry.");
        });
      toast.success(`Removed ${toRemove.length.toLocaleString()} product(s) from Live.`);
    },
    [bumpActive]
  );

  const deleteFromFound = useCallback((toRemove: ProductFinderListing[]) => {
    if (toRemove.length === 0) return;

    const deleted = new Set(deletedFoundRef.current);
    for (const l of toRemove) {
      for (const k of allListingKeys(l)) deleted.add(k);
    }
    deletedFoundRef.current = deleted;
    writeDeletedFoundKeys(deleted);

    const apiKeys = Array.from(new Set(toRemove.flatMap((l) => foundRemoveKeys(l))));
    void removeFoundProducts(apiKeys, toRemove)
      .then(() => bumpFound())
      .catch(() => {
        toast.message("Remove failed on server — retry.");
      });
    toast.success(`Removed ${toRemove.length} product(s) from Found.`);
  }, [bumpFound]);

  const clearAllFound = useCallback(() => {
    if (foundTotal <= 0) return;
    setConfirmAction({ kind: "clearFound", count: foundTotal });
  }, [foundTotal]);

  const performClearFound = useCallback(async () => {
    deletedFoundRef.current = new Set();
    writeDeletedFoundKeys(deletedFoundRef.current);
    try {
      const res = await clearFoundProducts();
      setFoundTotal(0);
      bumpFound();
      void refreshArchiveHints();
      toast.success(
        res.archived != null
          ? `Cleared Found (${res.cleared} items) — backup saved (${res.archived} rows).`
          : "Cleared all found products."
      );
    } catch {
      toast.message("Clear failed on server — retry.");
    }
  }, [bumpFound, refreshArchiveHints]);

  const unsaveProducts = useCallback(
    (listings: ProductFinderListing[]) => {
      if (listings.length === 0) return;
      setConfirmAction({ kind: "returnToFound", listings });
    },
    []
  );

  const performReturnToFound = useCallback(
    async (listings: ProductFinderListing[]) => {
      if (listings.length === 0) return;
      const enriched = enrichListingsProfit(listings, storeSettingsRef.current);
      try {
        const res = await restoreLibraryToFound("saved", enriched);
        const nextSaved = enrichListingsProfit(
          dedupeSavedByListingKey(res.saved ?? []),
          storeSettingsRef.current
        );
        setSaved(nextSaved);
        savedRef.current = nextSaved;
        writeSavedLocal(nextSaved);

        const deleted = new Set(deletedFoundRef.current);
        for (const l of enriched) {
          for (const k of allListingKeys(l)) deleted.delete(k);
        }
        deletedFoundRef.current = deleted;
        writeDeletedFoundKeys(deleted);

        setFoundTotal(res.foundTotal);
        bumpFound();
        setTab("found");
        toast.success(
          enriched.length === 1
            ? "Returned 1 product to Found."
            : `Returned ${res.restored} products to Found.`
        );
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not return to Found — nothing was removed."
        );
      }
    },
    [bumpFound, setTab]
  );

  const unsaveOne = useCallback(
    (listing: ProductFinderListing) => unsaveProducts([listing]),
    [unsaveProducts]
  );

  const unsaveMany = useCallback(
    (listings: ProductFinderListing[]) => unsaveProducts(listings),
    [unsaveProducts]
  );

  const clearSaved = useCallback(() => {
    if (savedRef.current.length === 0) return;
    setConfirmAction({ kind: "clearSaved", count: savedRef.current.length });
  }, []);

  const clearReserved = useCallback(() => {
    if (reservedRef.current.length === 0) return;
    setConfirmAction({ kind: "clearReserved", count: reservedRef.current.length });
  }, []);

  const performClearSaved = useCallback(async () => {
    try {
      const res = await clearLibraryProducts("saved");
      setSaved([]);
      savedRef.current = [];
      writeSavedLocal([]);
      void refreshArchiveHints();
      toast.success(
        res.archived
          ? `Cleared Saved (${res.cleared} items) — backup saved (${res.archived} rows).`
          : `Cleared Saved (${res.cleared} items).`
      );
    } catch {
      toast.error("Clear Saved failed on server — retry.");
    }
  }, [refreshArchiveHints]);

  const performClearReserved = useCallback(async () => {
    try {
      const res = await clearLibraryProducts("reserved");
      setReserved([]);
      reservedRef.current = [];
      writeReservedLocal([]);
      void refreshArchiveHints();
      toast.success(
        res.archived
          ? `Cleared Reserved (${res.cleared} items) — backup saved (${res.archived} rows).`
          : `Cleared Reserved (${res.cleared} items).`
      );
    } catch {
      toast.error("Clear Reserved failed on server — retry.");
    }
  }, [refreshArchiveHints]);

  const moveToReserved = useCallback(
    (listings: ProductFinderListing[]) => {
      const withAsin = listings.filter((l) => normalizeAsin(l.amazon_asin));
      if (withAsin.length === 0) return;

      const drop = new Set(withAsin.map((l) => listingKey(l)));
      const nextSaved = savedRef.current.filter((s) => !drop.has(listingKey(s)));
      const nextReserved = dedupeSavedByListingKey([
        ...reservedRef.current,
        ...enrichListingsProfit(withAsin, storeSettingsRef.current),
      ]);

      setSaved(nextSaved);
      savedRef.current = nextSaved;
      setReserved(nextReserved);
      reservedRef.current = nextReserved;
      writeSavedLocal(nextSaved);
      writeReservedLocal(nextReserved);

      void moveLibraryProducts("saved", "reserved", withAsin)
        .then((res) => {
          const enrichedSaved = enrichListingsProfit(
            dedupeSavedByListingKey(res.saved ?? nextSaved),
            storeSettingsRef.current
          );
          const enrichedReserved = enrichListingsProfit(
            dedupeSavedByListingKey(res.reserved ?? nextReserved),
            storeSettingsRef.current
          );
          setSaved(enrichedSaved);
          setReserved(enrichedReserved);
          savedRef.current = enrichedSaved;
          reservedRef.current = enrichedReserved;
          writeSavedLocal(enrichedSaved);
          writeReservedLocal(enrichedReserved);
        })
        .catch(() => {
          persistSaved(nextSaved);
          persistReserved(nextReserved);
          toast.error("Move to Reserved failed on server — retried sync.");
        });

      toast.success(
        withAsin.length === 1
          ? "Copied 1 ASIN → moved to Reserved."
          : `Copied ${withAsin.length} ASINs → moved to Reserved.`
      );
    },
    [persistSaved, persistReserved]
  );

  const unreserveProducts = useCallback(
    (listings: ProductFinderListing[]) => {
      if (listings.length === 0) return;
      const drop = new Set(listings.map((l) => listingKey(l)));
      const nextReserved = reservedRef.current.filter((s) => !drop.has(listingKey(s)));
      const nextSaved = dedupeSavedByListingKey([
        ...savedRef.current,
        ...enrichListingsProfit(listings, storeSettingsRef.current),
      ]);

      setSaved(nextSaved);
      savedRef.current = nextSaved;
      setReserved(nextReserved);
      reservedRef.current = nextReserved;
      writeSavedLocal(nextSaved);
      writeReservedLocal(nextReserved);

      void moveLibraryProducts("reserved", "saved", listings)
        .then((res) => {
          const enrichedSaved = enrichListingsProfit(
            dedupeSavedByListingKey(res.saved ?? nextSaved),
            storeSettingsRef.current
          );
          const enrichedReserved = enrichListingsProfit(
            dedupeSavedByListingKey(res.reserved ?? nextReserved),
            storeSettingsRef.current
          );
          setSaved(enrichedSaved);
          setReserved(enrichedReserved);
          savedRef.current = enrichedSaved;
          reservedRef.current = enrichedReserved;
          writeSavedLocal(enrichedSaved);
          writeReservedLocal(enrichedReserved);
        })
        .catch(() => {
          persistSaved(nextSaved);
          persistReserved(nextReserved);
          toast.error("Move back to Saved failed on server — retried sync.");
        });

      toast.success(
        listings.length === 1
          ? "Moved back to Saved."
          : `Moved ${listings.length} back to Saved.`
      );
    },
    [persistSaved, persistReserved]
  );

  const unreserveOne = useCallback(
    (listing: ProductFinderListing) => unreserveProducts([listing]),
    [unreserveProducts]
  );

  const unreserveMany = useCallback(
    (listings: ProductFinderListing[]) => unreserveProducts(listings),
    [unreserveProducts]
  );

  const dedupeSaved = useCallback(async () => {
    setDedupingLibrary(true);
    try {
      const res = await dedupeLibraryProducts("saved");
      const enriched = enrichListingsProfit(
        dedupeSavedByListingKey(res.listings ?? []),
        storeSettingsRef.current
      );
      setSaved(enriched);
      savedRef.current = enriched;
      writeSavedLocal(enriched);
      if (res.removed === 0) {
        toast.message("No duplicates in Saved.");
      } else {
        toast.success(`Removed ${res.removed} duplicates from Saved · ${res.total} left`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Dedupe failed");
    } finally {
      setDedupingLibrary(false);
    }
  }, []);

  const dedupeReserved = useCallback(async () => {
    setDedupingLibrary(true);
    try {
      const res = await dedupeLibraryProducts("reserved");
      const enriched = enrichListingsProfit(
        dedupeSavedByListingKey(res.listings ?? []),
        storeSettingsRef.current
      );
      setReserved(enriched);
      reservedRef.current = enriched;
      writeReservedLocal(enriched);
      if (res.removed === 0) {
        toast.message("No duplicates in Reserved.");
      } else {
        toast.success(`Removed ${res.removed} duplicates from Reserved · ${res.total} left`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Dedupe failed");
    } finally {
      setDedupingLibrary(false);
    }
  }, []);

  const handleConfirm = useCallback(async () => {
    if (!confirmAction) return;
    setConfirmLoading(true);
    try {
      switch (confirmAction.kind) {
        case "clearFound":
          await performClearFound();
          break;
        case "clearSaved":
          await performClearSaved();
          break;
        case "clearReserved":
          await performClearReserved();
          break;
        case "returnToFound":
          await performReturnToFound(confirmAction.listings);
          break;
        case "restoreArchive": {
          const res = await restoreArchiveSnapshot(confirmAction.source);
          void refreshArchiveHints();
          if (res.restored === 0) {
            toast.message("No backup to restore.");
            break;
          }
          if (confirmAction.source === "found") {
            setFoundTotal(res.foundTotal ?? 0);
            bumpFound();
            setTab("found");
          } else {
            const enrichedSaved = enrichListingsProfit(
              dedupeSavedByListingKey(res.saved ?? []),
              storeSettingsRef.current
            );
            const enrichedReserved = enrichListingsProfit(
              dedupeSavedByListingKey(res.reserved ?? []),
              storeSettingsRef.current
            );
            setSaved(enrichedSaved);
            setReserved(enrichedReserved);
            savedRef.current = enrichedSaved;
            reservedRef.current = enrichedReserved;
            writeSavedLocal(enrichedSaved);
            writeReservedLocal(enrichedReserved);
            if (confirmAction.source === "saved") setTab("saved");
            if (confirmAction.source === "reserved") setTab("reserved");
          }
          toast.success(`Restored ${res.restored} items from backup.`);
          break;
        }
      }
      setConfirmAction(null);
    } finally {
      setConfirmLoading(false);
    }
  }, [
    confirmAction,
    performClearFound,
    performClearSaved,
    performClearReserved,
    performReturnToFound,
    refreshArchiveHints,
    bumpFound,
    setTab,
  ]);

  const confirmCopy = useMemo(() => {
    if (!confirmAction) return null;
    switch (confirmAction.kind) {
      case "clearFound":
        return {
          title: "Clear all Found products?",
          description: `This will permanently remove ${confirmAction.count.toLocaleString()} items from Found. A server backup is saved automatically so you can recover with Restore backup.`,
          confirmLabel: "Yes, clear Found",
        };
      case "clearSaved":
        return {
          title: "Clear entire Saved list?",
          description: `This will remove all ${confirmAction.count.toLocaleString()} saved items. A server backup is saved automatically — use Restore backup if this was a mistake.`,
          confirmLabel: "Yes, clear Saved",
        };
      case "clearReserved":
        return {
          title: "Clear entire Reserved list?",
          description: `This will remove all ${confirmAction.count.toLocaleString()} reserved items. A server backup is saved automatically — use Restore backup if this was a mistake.`,
          confirmLabel: "Yes, clear Reserved",
        };
      case "returnToFound":
        return {
          title: "Return to Found?",
          description: `Move ${confirmAction.listings.length.toLocaleString()} item(s) from Saved back to Found. Nothing is deleted — products stay in the database.`,
          confirmLabel: "Return to Found",
          destructive: false,
        };
      case "restoreArchive":
        return {
          title: "Restore from backup?",
          description: `Restore ${confirmAction.count.toLocaleString()} items from the last ${confirmAction.source} backup. Existing rows with the same ID will be merged, not duplicated.`,
          confirmLabel: "Restore backup",
          destructive: false,
        };
    }
  }, [confirmAction]);

  const activeArchiveSource: PfArchiveSource | null =
    tab === "found"
      ? "found"
      : tab === "saved"
        ? "saved"
        : tab === "reserved"
          ? "reserved"
          : null;

  const activeArchive = activeArchiveSource ? archiveHint[activeArchiveSource] : null;

  useEffect(() => {
    const streams = new Map<string, EventSource>();
    const wire = (job: PfScanJob) => {
      if (streams.has(job.id)) return;
      const es = new EventSource(`/api/pf-scan/stream?jobId=${encodeURIComponent(job.id)}`);
      es.addEventListener("progress", (ev) => {
        try {
          const payload = JSON.parse((ev as MessageEvent).data) as Record<string, unknown>;
          const existing = queueMapRef.current.get(job.id) ?? {
            id: job.id,
            seller: job.seller,
            daysBack: job.daysBack,
            scanMode: job.scanType,
            status: "queued" as const,
          };
          const summary = (payload.summary as Record<string, unknown> | undefined) ?? {};
          const statusRaw = String(payload.status ?? job.status);
          const next: QueueItem = {
            ...existing,
            seller: job.seller,
            daysBack: job.daysBack,
            scanMode: job.scanType,
            status:
              statusRaw === "active"
                ? "running"
                : statusRaw === "queued"
                  ? "queued"
                  : statusRaw === "done"
                    ? "done"
                    : "failed",
            matched: Number(summary.matched_to_amazon ?? existing.matched ?? 0),
            total: Number(summary.total_listings ?? existing.total ?? 0),
            costUsd: Number(summary.proxy_cost_usd ?? existing.costUsd ?? 0),
            error: (payload.error as string | undefined) ?? existing.error,
            forceRefresh: job.forceRefresh || undefined,
          };
          queueMapRef.current.set(job.id, next);
          if (next.status === "done" || next.status === "failed") {
            archiveAndRemoveQueueItem(next);
            if (next.scanMode === "active") bumpActive();
            else bumpFound();
            streams.get(job.id)?.close();
            streams.delete(job.id);
          }
          syncQueue();
        } catch {
          // ignore malformed progress packet
        }
      });
      streams.set(job.id, es);
    };

    for (const item of queueView) {
      if (item.status === "queued" || item.status === "running") {
        wire({
          id: item.id,
          tenantId: "default",
          seller: item.seller,
          scanType: item.scanMode === "active" ? "active" : "sold",
          daysBack: item.daysBack,
          forceRefresh: Boolean(item.forceRefresh),
          status: item.status === "running" ? "active" : "queued",
          createdAt: "",
          updatedAt: "",
        });
      }
    }
    return () => {
      for (const es of Array.from(streams.values())) es.close();
    };
  }, [queueView, archiveAndRemoveQueueItem, bumpActive, bumpFound, syncQueue]);

  const enqueue = useCallback(
    (
      rawInput: string,
      daysBack: number,
      forceRefresh = false,
      fetchPrices = true,
      options?: { silentDuplicate?: boolean; switchTab?: boolean }
    ): boolean => {
      const parsed = parseEbaySellerInput(rawInput);
      const norm = parsed.seller;
      if (!isValidSellerName(norm)) {
        if (!options?.silentDuplicate) {
          toast.error(`Invalid seller username: "${rawInput.trim() || "(empty)"}"`);
        }
        return false;
      }

      const dupActive = Array.from(queueMapRef.current.values()).find(
        (it) =>
          it.seller.toLowerCase() === norm.toLowerCase() &&
          it.daysBack === daysBack &&
          (it.status === "queued" || it.status === "running")
      );
      if (dupActive) {
        if (!options?.silentDuplicate) {
          toast.message(`${norm} (${daysBack}d) is already in the queue.`);
        }
        return false;
      }

      void postPfScan({
        seller: parsed.apiInput,
        scanType: "sold",
        daysBack,
        forceRefresh,
        fetchPrices,
        storeSettings: (storeSettingsRef.current ?? {}) as Record<string, unknown>,
      })
        .then(async () => {
          const jobs = await getPfScanJobs();
          for (const j of jobs.jobs) {
            queueMapRef.current.set(j.id, {
              id: j.id,
              seller: j.seller,
              daysBack: j.daysBack,
              scanMode: j.scanType as "sold" | "active",
              status: j.status === "active" ? "running" : (j.status as QueueItem["status"]),
              forceRefresh: j.forceRefresh || undefined,
            });
          }
          syncQueue();
        })
        .catch((err) => {
          toast.error(err instanceof Error ? err.message : "Queue add failed");
        });
      return true;
    },
    [syncQueue]
  );

  const enqueueMany = useCallback(
    (
      entries: StoredSellerSearch[],
      daysBack: number,
      forceRefresh = false,
      fetchPrices = true
    ) => {
      if (entries.length === 0) return { queued: 0, skipped: 0 };
      let queued = 0;
      let skipped = 0;
      for (const entry of entries) {
        const ok = enqueue(
          entry.sellerInput ?? entry.seller,
          daysBack,
          forceRefresh,
          fetchPrices,
          { silentDuplicate: true, switchTab: false }
        );
        if (ok) queued += 1;
        else skipped += 1;
      }
      if (queued > 0) {
        toast.success(
          `Queued ${queued} seller(s) for ${daysBack}-day scan` +
            (skipped > 0 ? ` · ${skipped} already in queue` : "") +
            (forceRefresh ? "" : " · cache used when fresh (no proxy)")
        );
      } else if (skipped > 0) {
        toast.message(`All ${skipped} seller(s) already in queue.`);
      }
      return { queued, skipped };
    },
    [enqueue]
  );

  const refreshWatchlist7d = useCallback(
    (entries?: StoredSellerSearch[]) => {
      const list = entries ?? uniqueSellerHistory();
      if (list.length === 0) {
        toast.message("No sellers in watchlist — scan some first.");
        return;
      }
      enqueueMany(list, WEEKLY_REFRESH_DAYS, false, true);
    },
    [enqueueMany]
  );

  const viewSellerInFound = useCallback((seller: string) => {
    setFocusFoundSeller(seller);
    setTab("found");
  }, [setTab]);

  const viewSellerInActive = useCallback((seller: string) => {
    setFocusActiveSeller(seller);
    setTab("active");
  }, [setTab]);

  const scanActiveSeller = useCallback(
    (sellerInput: string, forceRefresh = false) => {
      const parsed = parseEbaySellerInput(sellerInput);
      const norm = parsed.seller;
      if (!isValidSellerName(norm)) {
        toast.error(`Invalid seller: "${sellerInput.trim() || "(empty)"}"`);
        return false;
      }
      const dup = Array.from(queueMapRef.current.values()).find(
        (it) =>
          it.seller.toLowerCase() === norm.toLowerCase() &&
          it.scanMode === "active" &&
          (it.status === "queued" || it.status === "running")
      );
      if (dup) {
        toast.message(`${norm} live scan is already in the queue.`);
        return false;
      }
      void postPfScan({
        seller: parsed.apiInput,
        scanType: "active",
        daysBack: 0,
        forceRefresh,
        fetchPrices: true,
        storeSettings: (storeSettingsRef.current ?? {}) as Record<string, unknown>,
      })
        .then(() => getPfScanJobs())
        .then((jobs) => {
          for (const j of jobs.jobs) {
            queueMapRef.current.set(j.id, {
              id: j.id,
              seller: j.seller,
              daysBack: j.daysBack,
              scanMode: j.scanType as "sold" | "active",
              status: j.status === "active" ? "running" : (j.status as QueueItem["status"]),
              forceRefresh: j.forceRefresh || undefined,
            });
          }
          syncQueue();
        })
        .catch((err) => {
          toast.error(err instanceof Error ? err.message : "Live queue add failed");
        });
      toast.message(`Queued live scan for ${norm} — watch Queue tab for progress.`);
      return true;
    },
    [syncQueue]
  );

  const importManyToFound = useCallback(
    async (entries: StoredSellerSearch[]) => {
      const toImport = entries.filter((e) => (e.matched ?? 0) > 0);
      if (toImport.length === 0) {
        toast.message("No scanned sellers to import.");
        return;
      }
      setImportingBulk(true);
      let totalImported = 0;
      let ok = 0;
      let fail = 0;
      let lastTotal = foundTotal;
      try {
        toast.message(`Importing ${toImport.length} seller(s) into Found…`);
        for (const entry of toImport) {
          setImportingSeller(entry.seller);
          try {
            const res = await importFoundFromAnalysis(entry.seller, entry.daysBack);
            totalImported += res.imported;
            lastTotal = res.total;
            ok += 1;
          } catch {
            fail += 1;
          }
        }
        setFoundTotal(lastTotal);
        bumpFound();
        setPastSellersRefresh((n) => n + 1);
        try {
          const deduped = await dedupeFoundProducts();
          if (deduped.removed > 0) {
            setFoundTotal(deduped.total);
            bumpFound();
          }
        } catch {
          /* optional cleanup */
        }
        if (ok === 0) {
          toast.error(`Import failed for all ${toImport.length} seller(s).`);
        } else {
          toast.success(
            `Imported ${totalImported.toLocaleString()} rows from ${ok} seller(s)` +
              (fail > 0 ? ` · ${fail} failed` : "") +
              ` · ${lastTotal.toLocaleString()} total in Found`
          );
        }
      } finally {
        setImportingSeller(null);
        setImportingBulk(false);
      }
    },
    [bumpFound, foundTotal]
  );

  const importSellerToFound = useCallback(
    async (entry: StoredSellerSearch) => {
      setImportingSeller(entry.seller);
      try {
        const res = await importFoundFromAnalysis(entry.seller, entry.daysBack);
        setFoundTotal((prev) => (prev === res.total ? prev : res.total));
        bumpFound();
        setPastSellersRefresh((n) => n + 1);
        toast.success(
          `${entry.seller}: ${res.imported.toLocaleString()} imported · ${res.sellerInFound.toLocaleString()} in Found for this seller`
        );
        try {
          const deduped = await dedupeFoundProducts();
          if (deduped.removed > 0) {
            setFoundTotal(deduped.total);
            bumpFound();
            toast.message(`Removed ${deduped.removed} duplicate rows.`);
          }
        } catch {
          /* optional */
        }
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Import failed — try Fresh scan"
        );
      } finally {
        setImportingSeller(null);
      }
    },
    [bumpFound]
  );

  const retryQueued = useCallback(
    (id: string) => {
      const item = queueMapRef.current.get(id);
      if (!item || item.status !== "failed") return;
      void postPfScan({
        seller: item.sellerInput ?? item.seller,
        scanType: item.scanMode === "active" ? "active" : "sold",
        daysBack: item.daysBack,
        forceRefresh: Boolean(item.forceRefresh),
        fetchPrices: item.fetchPrices !== false,
      }).then(() => getPfScanJobs()).then((jobs) => {
        for (const j of jobs.jobs) {
          queueMapRef.current.set(j.id, {
            id: j.id,
            seller: j.seller,
            daysBack: j.daysBack,
            scanMode: j.scanType as "sold" | "active",
            status: j.status === "active" ? "running" : (j.status as QueueItem["status"]),
            forceRefresh: j.forceRefresh || undefined,
          });
        }
        syncQueue();
      }).catch(() => undefined);
    },
    [syncQueue]
  );

  const retryAllFailed = useCallback(() => {
    let n = 0;
    for (const it of Array.from(queueMapRef.current.values())) {
      if (it.status === "failed") {
        n += 1;
        void postPfScan({
          seller: it.sellerInput ?? it.seller,
          scanType: it.scanMode === "active" ? "active" : "sold",
          daysBack: it.daysBack,
          forceRefresh: Boolean(it.forceRefresh),
          fetchPrices: it.fetchPrices !== false,
        }).catch(() => undefined);
      }
    }
    if (n === 0) return;
    toast.message(`Re-queued ${n} failed seller(s).`);
  }, []);

  const removeQueued = (id: string) => {
    void cancelPfScan(id)
      .then(() => {
        queueMapRef.current.delete(id);
        syncQueue();
      })
      .catch(() => undefined);
  };

  const stopAllQueued = useCallback(() => {
    const items = Array.from(queueMapRef.current.values());
    const waiting = items.filter((it) => it.status === "queued").length;
    const running = items.filter((it) => it.status === "running").length;
    if (waiting === 0 && running === 0) {
      toast.message("Queue is empty.");
      return;
    }
    for (const it of items.filter((x) => x.status === "queued")) {
      void cancelPfScan(it.id).catch(() => undefined);
      queueMapRef.current.delete(it.id);
    }
    syncQueue();
    if (waiting > 0) {
      toast.success(
        running > 0
          ? `Stopped ${waiting} waiting seller(s). Current scan will finish.`
          : `Stopped ${waiting} waiting seller(s).`
      );
    } else {
      toast.message("No waiting sellers — current scan will finish.");
    }
  }, [syncQueue]);

  const clearFinished = () => {
    for (const it of Array.from(queueMapRef.current.values())) {
      if (it.status === "done" || it.status === "failed") {
        archiveAndRemoveQueueItem(it);
      }
    }
    syncQueue();
  };

  const requeuePastSeller = useCallback(
    (entry: StoredSellerSearch) => {
      refreshWatchlist7d([entry]);
    },
    [refreshWatchlist7d]
  );

  const watchlistCount = useMemo(
    () => uniqueSellerHistory().length,
    [pastSellersRefresh]
  );

  const activeQueueKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const it of queueView) {
      if (it.status === "queued" || it.status === "running") {
        keys.add(`${it.seller.toLowerCase()}::${it.daysBack}`);
        if (it.scanMode === "active") {
          keys.add(`${it.seller.toLowerCase()}::live`);
        }
      }
    }
    return keys;
  }, [queueView]);

  const queuedCount = queueView.filter((i) => i.status === "queued" || i.status === "running").length;
  const tabs = [
    { id: "queue" as const, title: "Queue", count: queuedCount },
    { id: "sellers" as const, title: "Sellers", count: watchlistCount },
    { id: "found" as const, title: "Found", count: foundTotal },
    { id: "active" as const, title: "Live", count: activeTotal },
    { id: "saved" as const, title: "Saved", count: saved.length },
    { id: "reserved" as const, title: "Reserved", count: reserved.length },
  ];

  return (
    <Layout
      title="Product Finder"
      breadcrumb="Home / Product Finder"
      description="Analyze any eBay seller to find profitable products."
      fullWidth
      flush
    >
      <div className="pf-page -mx-1 space-y-5">
        <SellerSearch onAnalyze={enqueue} />

        <div className="tabs-bar sticky top-[44px] z-10 -mx-1 bg-surface px-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn("tab-item", tab === t.id && "tab-item-active")}
            >
              {t.title}
              <span className="tab-count">{t.count.toLocaleString()}</span>
            </button>
          ))}
        </div>

        {activeArchive && activeArchive.count > 0 && activeArchiveSource ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200/80 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            <span>
              Backup available: {activeArchive.count.toLocaleString()} {activeArchiveSource} items
              {activeArchive.archivedAt
                ? ` (saved ${new Date(activeArchive.archivedAt).toLocaleString()})`
                : ""}
            </span>
            <Button
              size="sm"
              variant="secondary"
              type="button"
              onClick={() =>
                setConfirmAction({
                  kind: "restoreArchive",
                  source: activeArchiveSource,
                  count: activeArchive.count,
                })
              }
            >
              Restore backup
            </Button>
          </div>
        ) : null}

        <div className="min-h-[560px]">
          <div className={tab === "queue" ? undefined : "hidden"}>
            <QueuePanel
              items={queueView.filter(
                (it) => it.status === "queued" || it.status === "running"
              )}
              onRemove={removeQueued}
              onClearFinished={clearFinished}
              onRetry={retryQueued}
              onRetryAllFailed={retryAllFailed}
              onStopAll={stopAllQueued}
            />
          </div>

          <div className={tab === "sellers" ? undefined : "hidden"}>
            <SellersWatchlistPanel
              refreshKey={pastSellersRefresh}
              activeQueueKeys={activeQueueKeys}
              onRefreshOne={requeuePastSeller}
              onRefreshMany={refreshWatchlist7d}
              onRefreshAll={() => refreshWatchlist7d()}
              onChanged={() => setPastSellersRefresh((n) => n + 1)}
              onViewInFound={viewSellerInFound}
              onViewInActive={viewSellerInActive}
              onScanActive={(seller) => scanActiveSeller(seller, true)}
              onImportToFound={importSellerToFound}
              onImportManyToFound={importManyToFound}
              importingSeller={importingSeller}
              importingBulk={importingBulk}
            />
          </div>

          <div className={tab === "found" ? undefined : "hidden"}>
            <FoundProductsPanel
              active={tab === "found"}
              refreshKey={foundRefreshKey}
              globalFoundTotal={foundTotal}
              focusSeller={focusFoundSeller}
              onFocusSellerApplied={() => setFocusFoundSeller(null)}
              storeSettings={storeSettings}
              onSave={saveListing}
              onSaveMany={saveMany}
              onDeleteMany={deleteFromFound}
              onClearAll={clearAllFound}
            />
          </div>

          <div className={tab === "active" ? undefined : "hidden"}>
            <ActiveListingsPanel
              active={tab === "active"}
              refreshKey={activeRefreshKey}
              globalActiveTotal={activeTotal}
              focusSeller={focusActiveSeller}
              onFocusSellerApplied={() => setFocusActiveSeller(null)}
              storeSettings={storeSettings}
              onSave={saveListingFromLive}
              onSaveMany={saveManyFromLive}
              onDeleteMany={deleteFromActive}
              onScanSeller={(seller) => scanActiveSeller(seller, true)}
              scanningSeller={scanningActiveSeller}
            />
          </div>

          <div className={tab === "saved" ? undefined : "hidden"}>
            <SavedProductsPanel
              saved={saved}
              panelMode="saved"
              onUnsave={unsaveOne}
              onUnsaveMany={unsaveMany}
              onClear={clearSaved}
              onReserve={moveToReserved}
              onDedupe={dedupeSaved}
              deduping={dedupingLibrary}
              storeSettings={storeSettings}
              onAddAllToStore={(asins) => {
                if (!storeId) {
                  toast.error("Select a store first to add products.");
                  return;
                }
                if (asins.length === 0) return;
                setAddAsins(asins);
              }}
            />
          </div>

          <div className={tab === "reserved" ? undefined : "hidden"}>
            <SavedProductsPanel
              saved={reserved}
              panelMode="reserved"
              onUnsave={unreserveOne}
              onUnsaveMany={unreserveMany}
              onClear={clearReserved}
              onDedupe={dedupeReserved}
              deduping={dedupingLibrary}
              storeSettings={storeSettings}
              onAddAllToStore={(asins) => {
                if (!storeId) {
                  toast.error("Select a store first to add products.");
                  return;
                }
                if (asins.length === 0) return;
                setAddAsins(asins);
              }}
            />
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={confirmAction != null && confirmCopy != null}
        title={confirmCopy?.title ?? ""}
        description={confirmCopy?.description ?? ""}
        confirmLabel={confirmCopy?.confirmLabel ?? "Confirm"}
        destructive={confirmCopy?.destructive !== false}
        loading={confirmLoading}
        onConfirm={() => void handleConfirm()}
        onCancel={() => {
          if (!confirmLoading) setConfirmAction(null);
        }}
      />

      <AddProductModal
        open={addAsins != null}
        onClose={() => setAddAsins(null)}
        storeId={storeId}
        initialAsins={addAsins ?? undefined}
        onPublished={() => bumpListingsVersion()}
      />
    </Layout>
  );
}
