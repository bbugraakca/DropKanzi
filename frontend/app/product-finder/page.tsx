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
  analyzeSeller,
  analyzeActiveSeller,
  getStoreSettings,
  importFoundFromAnalysis,
  mergeFoundProducts,
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
import { formatBytes } from "@/lib/formatBytes";
import { addProxyTotals } from "@/lib/productFinderProxy";
import {
  filterAcceptedMatches,
  isAcceptedMatch,
  countAcceptedMatches,
  countAcceptedPricesLoaded,
} from "@/lib/productFinderMatch";
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
  readQueueLocal,
  dedupeSavedByListingKey,
  mergeListing,
  normalizeAsin,
  writeQueueLocal,
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

const MAX_PARALLEL_SELLERS = 1;
const SELLER_COOLDOWN_MS = 400;
const EMPTY_RETRY_DELAY_MS = 2500;
const EMPTY_RETRY_MAX = 2;
const NETWORK_RETRY_MAX = 3;
const NETWORK_RETRY_DELAY_MS = 6000;
const PF_TAB_STORAGE_KEY = "pf_active_tab";

type PfTab = "queue" | "sellers" | "found" | "active" | "saved" | "reserved";

type ConfirmAction =
  | { kind: "clearFound"; count: number }
  | { kind: "clearSaved"; count: number }
  | { kind: "clearReserved"; count: number }
  | { kind: "returnToFound"; listings: ProductFinderListing[] }
  | { kind: "restoreArchive"; source: PfArchiveSource; count: number };

function isRetryableAnalyzeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /api connection failed|cannot reach api|failed to fetch|fetch failed|network|502|503|504|scraper failed|scraper connection|econnrefused|enotfound|socket hang up|connection lost|backend unreachable|und_err|other side closed|siglip warmup/i.test(
    msg
  );
}

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
  const [foundTotal, setFoundTotal] = useState(0);
  const [foundRefreshKey, setFoundRefreshKey] = useState(0);
  const [activeTotal, setActiveTotal] = useState(0);
  const [activeRefreshKey, setActiveRefreshKey] = useState(0);
  const [focusActiveSeller, setFocusActiveSeller] = useState<string | null>(null);
  const [scanningActiveSeller, setScanningActiveSeller] = useState<string | null>(null);
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

  const queueRef = useRef<QueueItem[]>([]);
  const activeRef = useRef(0);
  const queuePausedRef = useRef(false);
  const pumpRef = useRef<() => void>(() => {});
  const storeIdRef = useRef(storeId);
  const storeSettingsRef = useRef(storeSettings);
  const savedRef = useRef(saved);
  const reservedRef = useRef(reserved);
  storeIdRef.current = storeId;
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
    const snapshot = [...queueRef.current];
    setQueueView(snapshot);
    writeQueueLocal(
      snapshot.filter((it) => it.status === "queued" || it.status === "running")
    );
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
    queueRef.current = queueRef.current.filter((it) => it.id !== item.id);
    setPastSellersRefresh((n) => n + 1);
  }, []);

  // Restore active queue only; finished runs live under Past sellers.
  useEffect(() => {
    const stored = readQueueLocal();
    const finished = stored.filter(
      (it) => it.status === "done" || it.status === "failed"
    );
    if (finished.length > 0) {
      rememberSellerSearches(
        finished.map((it) => ({
          seller: it.seller,
          daysBack: it.daysBack,
          matched: it.matched,
          total: it.total,
          status: it.status as "done" | "failed",
          error: it.error,
          costUsd: it.costUsd,
          costBytes: it.costBytes,
          costRequests: it.costRequests,
          cached: it.cached,
          costStages: it.costStages,
          matchTitlesAttempted: it.matchAttempted,
          matchTitlesSkipped: it.matchSkipped,
          serpLookups: it.serpLookups,
          serpProxy: it.serpProxy,
          serpDirect: it.serpDirect,
        }))
      );
      setPastSellersRefresh((n) => n + 1);
    }

    const active = stored.filter(
      (it) =>
        isValidSellerName(it.seller) &&
        (it.status === "queued" || it.status === "running")
    );
    if (active.length === 0 && finished.length === 0) return;

    queueRef.current = active.map((it) =>
      it.status === "running" ? { ...it, status: "queued" as const } : it
    );
    syncQueue();

    const pending = queueRef.current.some((it) => it.status === "queued");
    if (pending) {
      const t = window.setTimeout(() => pumpRef.current(), 400);
      return () => window.clearTimeout(t);
    }
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

  const analyzeSellerWithRetry = useCallback(
    async (
      seller: string,
      daysBack: number,
      force: boolean,
      fetchPrices: boolean,
      onRetry?: (attempt: number) => void
    ) => {
      let lastErr: unknown;
      for (let attempt = 0; attempt <= NETWORK_RETRY_MAX; attempt++) {
        try {
          return await analyzeSeller(
            seller,
            daysBack,
            storeIdRef.current,
            force,
            fetchPrices
          );
        } catch (err) {
          lastErr = err;
          if (!isRetryableAnalyzeError(err) || attempt === NETWORK_RETRY_MAX) {
            throw err;
          }
          onRetry?.(attempt + 1);
          await new Promise((r) =>
            setTimeout(r, NETWORK_RETRY_DELAY_MS * (attempt + 1))
          );
        }
      }
      throw lastErr;
    },
    []
  );

  const analyzeActiveWithRetry = useCallback(
    async (
      seller: string,
      force: boolean,
      fetchPrices: boolean,
      onRetry?: (attempt: number) => void
    ) => {
      let lastErr: unknown;
      for (let attempt = 0; attempt <= NETWORK_RETRY_MAX; attempt++) {
        try {
          return await analyzeActiveSeller(
            seller,
            storeIdRef.current,
            force,
            fetchPrices
          );
        } catch (err) {
          lastErr = err;
          if (!isRetryableAnalyzeError(err) || attempt === NETWORK_RETRY_MAX) {
            throw err;
          }
          onRetry?.(attempt + 1);
          await new Promise((r) =>
            setTimeout(r, NETWORK_RETRY_DELAY_MS * (attempt + 1))
          );
        }
      }
      throw lastErr;
    },
    []
  );

  const runOne = useCallback(
    async (item: QueueItem) => {
      try {
        const force = Boolean(item.forceRefresh);
        const fetchPrices = item.fetchPrices !== false;
        const isActiveScan = item.scanMode === "active";

        if (isActiveScan) {
          setScanningActiveSeller(item.seller);
        }

        let data = isActiveScan
          ? await analyzeActiveWithRetry(
              item.sellerInput ?? item.seller,
              force,
              fetchPrices,
              (attempt) => {
                toast.message(
                  `${item.seller}: live scan connection error — retry ${attempt}/${NETWORK_RETRY_MAX}…`
                );
              }
            )
          : await analyzeSellerWithRetry(
              item.sellerInput ?? item.seller,
              item.daysBack,
              force,
              fetchPrices,
              (attempt) => {
                toast.message(
                  `${item.seller}: connection error — retry ${attempt}/${NETWORK_RETRY_MAX}…`
                );
              }
            );

        if (!isActiveScan) {
          for (let retry = 0; retry < EMPTY_RETRY_MAX && data.summary.total_listings === 0; retry++) {
            await new Promise((r) => setTimeout(r, EMPTY_RETRY_DELAY_MS));
            data = await analyzeSellerWithRetry(
              item.sellerInput ?? item.seller,
              item.daysBack,
              force,
              fetchPrices,
              (attempt) => {
                toast.message(
                  `${item.seller}: retry empty result (${attempt}/${NETWORK_RETRY_MAX})…`
                );
              }
            );
          }
        }

        const withPrices = enrichListingsProfit(
          data.listings,
          storeSettingsRef.current
        );
        const accepted = filterAcceptedMatches(withPrices);
        const matchedReported = Math.max(
          accepted.length,
          Number(data.summary.matched_to_amazon ?? 0)
        );
        const pricesLoaded = countAcceptedPricesLoaded(
          accepted.length > 0
            ? accepted
            : withPrices.filter((l) => l.amazon_asin && isAcceptedMatch(l))
        );
        const extraProxy = {};
        const proxyTotals = addProxyTotals(
          {
            proxy_bytes: data.summary.proxy_bytes,
            proxy_cost_usd: data.summary.proxy_cost_usd,
            proxy_requests: data.summary.proxy_requests,
            proxy_stages: data.summary.proxy_stages,
          },
          extraProxy
        );

        if (isActiveScan) {
          bumpActive();
          item.status = "done";
          item.matched = matchedReported;
          item.total = data.summary.total_listings;
          item.pricesLoaded = pricesLoaded;
          item.pricesTotal = matchedReported;
          item.cached = data.cached;
          item.costUsd = proxyTotals.costUsd;
          item.costBytes = proxyTotals.costBytes;
          item.costRequests = proxyTotals.costRequests;
          item.costStages = proxyTotals.costStages;
          item.ebaySellerId = data.summary.ebay_seller_id as string | undefined;
          item.ebayStoreResolved = Boolean(data.summary.ebay_store_resolved);
          toast.success(
            `${item.seller}: ${matchedReported} live matches · ${data.summary.total_listings} active scraped`
          );
          return;
        }

        let syncImported = 0;
        let visibleAfter = 0;
        try {
          const imp = await importFoundFromAnalysis(item.seller, item.daysBack);
          syncImported = imp.imported;
          visibleAfter = imp.total;
          setFoundTotal((prev) => (prev === imp.total ? prev : imp.total));
          bumpFound();
        } catch {
          syncImported = 0;
        }

        item.status = "done";
        item.matched = matchedReported;
        item.foundAdded = syncImported;
        item.total = data.summary.total_listings;
        item.pricesLoaded = pricesLoaded;
        item.pricesTotal = matchedReported;
        item.cached = Boolean(data.cached);
        item.costUsd = proxyTotals.costUsd;
        item.costBytes = proxyTotals.costBytes;
        item.costRequests = proxyTotals.costRequests;
        item.costStages = proxyTotals.costStages;
        item.matchSkipped = data.summary.match_groups_skipped;
        item.matchAttempted = data.summary.match_groups_attempted;
        item.serpLookups = data.summary.serp_lookups;
        item.serpProxy = data.summary.serp_proxy_requests;
        item.serpDirect = data.summary.serp_direct_requests;
        item.captchaAborted = data.summary.match_captcha_aborted;
        item.ebayStatus = data.summary.ebay_status;
        item.ebayMessage = data.summary.ebay_message;
        item.ebaySellerId = data.summary.ebay_seller_id;
        item.ebayStoreResolved = data.summary.ebay_store_resolved;
        const persistWarn = (data.summary as { persist_warning?: string }).persist_warning;
        if (persistWarn) {
          toast.warning(`${item.seller}: saved to Found but DB cache failed — ${persistWarn}`);
        }
        if (data.summary.total_listings === 0) {
          const hint =
            data.summary.ebay_message ??
            "No eBay sold listings in this window — try 30/90 days or verify the username.";
          toast.warning(`${item.seller}: ${hint}`);
        } else if (visibleAfter > 0 || syncImported > 0) {
          const priceNote =
            pricesLoaded < matchedReported
              ? ` · ${pricesLoaded}/${matchedReported} prices`
              : matchedReported > 0
                ? ` · ${pricesLoaded} prices`
                : "";
          const proxyNote =
            proxyTotals.costBytes > 0
              ? ` · ${formatBytes(proxyTotals.costBytes)} · $${proxyTotals.costUsd < 0.01 ? proxyTotals.costUsd.toFixed(4) : proxyTotals.costUsd.toFixed(2)} proxy`
              : item.cached
                ? " · cached (no proxy)"
                : "";
          toast.success(
            `${item.seller}: ${visibleAfter} in Found (${syncImported} from scan)${priceNote}${proxyNote}`
          );
        } else if (matchedReported > 0) {
          toast.warning(
            `${item.seller}: ${matchedReported} matches on server — open Found tab and tap Import, or refresh the page.`
          );
        } else {
          const skipped = data.summary.match_groups_skipped ?? 0;
          const captcha = data.summary.match_captcha_aborted;
          const mb =
            proxyTotals.costBytes > 0
              ? `${(proxyTotals.costBytes / (1024 * 1024)).toFixed(1)} MB proxy`
              : "";
          toast.warning(
            `${item.seller}: 0 Amazon matches from ${data.summary.total_listings} eBay sold` +
              (skipped > 0
                ? ` — searched ${data.summary.match_groups_attempted ?? "?"} newest unique titles, skipped ${skipped}`
                : "") +
              (captcha ? " — Amazon captcha/block" : "") +
              (mb ? ` · ${mb} proxy` : "") +
              ". Try 7-day window."
          );
        }
      } catch (err) {
        item.status = "failed";
        const raw = err instanceof Error ? err.message : "Analysis failed";
        item.error = /api connection failed|failed to fetch|networkerror|load failed/i.test(raw)
          ? "Connection lost — Retry (keep tab open on http://127.0.0.1:3000, Ctrl+F5 first)"
          : /request failed \(500\)|scan proxy error/i.test(raw)
            ? "Scan timed out in UI proxy — retry; use Fresh scan off if seller was scanned before"
          : /scraper failed/i.test(raw)
            ? raw.replace(/^Scraper failed:?\s*/i, "Scraper: ")
            : raw.length > 120
              ? `${raw.slice(0, 120)}…`
              : raw;
        toast.error(`${item.seller}: ${item.error}`);
      } finally {
        setScanningActiveSeller(null);
        archiveAndRemoveQueueItem(item);
        activeRef.current -= 1;
        syncQueue();
        setPastSellersRefresh((n) => n + 1);
        setTimeout(() => pumpRef.current(), SELLER_COOLDOWN_MS);
      }
    },
    [syncQueue, analyzeSellerWithRetry, analyzeActiveWithRetry, archiveAndRemoveQueueItem, bumpFound, bumpActive]
  );

  const pump = useCallback(() => {
    if (queuePausedRef.current) return;
    while (activeRef.current < MAX_PARALLEL_SELLERS) {
      const next = queueRef.current.find((it) => it.status === "queued");
      if (!next) break;
      next.status = "running";
      activeRef.current += 1;
      syncQueue();
      void runOne(next);
    }
  }, [runOne, syncQueue]);

  useEffect(() => {
    pumpRef.current = pump;
  }, [pump]);

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

      const dupActive = queueRef.current.find(
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

      queuePausedRef.current = false;

      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      queueRef.current.push({
        id,
        seller: norm,
        sellerInput: parsed.apiInput,
        daysBack,
        status: "queued",
        forceRefresh: forceRefresh || undefined,
        fetchPrices: fetchPrices ? undefined : false,
      });
      syncQueue();
      pump();
      return true;
    },
    [pump, syncQueue]
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
      const dup = queueRef.current.find(
        (it) =>
          it.seller.toLowerCase() === norm.toLowerCase() &&
          it.scanMode === "active" &&
          (it.status === "queued" || it.status === "running")
      );
      if (dup) {
        toast.message(`${norm} live scan is already in the queue.`);
        return false;
      }
      queuePausedRef.current = false;
      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      queueRef.current.push({
        id,
        seller: norm,
        sellerInput: parsed.apiInput,
        daysBack: 0,
        scanMode: "active",
        status: "queued",
        forceRefresh: forceRefresh || undefined,
      });
      syncQueue();
      pump();
      toast.message(`Queued live scan for ${norm} — watch Queue tab for progress.`);
      return true;
    },
    [pump, syncQueue]
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
      const item = queueRef.current.find((it) => it.id === id);
      if (!item || item.status !== "failed") return;
      item.status = "queued";
      item.error = undefined;
      syncQueue();
      pump();
    },
    [pump, syncQueue]
  );

  const retryAllFailed = useCallback(() => {
    let n = 0;
    for (const it of queueRef.current) {
      if (it.status === "failed") {
        it.status = "queued";
        it.error = undefined;
        n += 1;
      }
    }
    if (n === 0) return;
    syncQueue();
    pump();
    toast.message(`Re-queued ${n} failed seller(s).`);
  }, [pump, syncQueue]);

  const removeQueued = (id: string) => {
    queueRef.current = queueRef.current.filter((it) => it.id !== id);
    syncQueue();
  };

  const stopAllQueued = useCallback(() => {
    const waiting = queueRef.current.filter((it) => it.status === "queued").length;
    const running = queueRef.current.filter((it) => it.status === "running").length;
    if (waiting === 0 && running === 0) {
      toast.message("Queue is empty.");
      return;
    }
    queueRef.current = queueRef.current.filter((it) => it.status !== "queued");
    queuePausedRef.current = true;
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
    for (const it of queueRef.current) {
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

  const queuedCount = queueView.filter(
    (i) => i.status === "queued" || i.status === "running"
  ).length;
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
