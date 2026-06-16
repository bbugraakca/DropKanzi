import { create } from "zustand";

type AppState = {
  activeStoreId: string | null;
  setActiveStoreId: (id: string | null) => void;
  /** Increment after Add Product publish so Listing page reloads. */
  listingsVersion: number;
  bumpListingsVersion: () => void;
};

const STORAGE_KEY = "dropkanzi.activeStoreId";

function loadInitial(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export const useAppStore = create<AppState>((set) => ({
  activeStoreId: loadInitial(),
  listingsVersion: 0,
  bumpListingsVersion: () =>
    set((s) => ({ listingsVersion: s.listingsVersion + 1 })),
  setActiveStoreId: (id) => {
    set({ activeStoreId: id });
    if (typeof window === "undefined") return;
    try {
      if (!id) window.localStorage.removeItem(STORAGE_KEY);
      else window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // ignore storage errors
    }
  },
}));

