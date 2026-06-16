"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Home,
  ClipboardList,
  List,
  Mail,
  Settings,
  CreditCard,
  Plus,
  Layers,
  ChevronDown,
  Search,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { cn } from "@/lib/utils";
import { getStores } from "@/lib/api";
import type { Store } from "@/lib/types";
import { useAppStore } from "@/lib/store/appStore";
import { ConnectEbayModal } from "@/components/stores/ConnectEbayModal";
import { AddProductModal } from "@/components/products/AddProductModal";
import {
  STORE_SETTINGS_CATALOG,
  STORE_SETTINGS_GROUPS,
} from "@/lib/storeSettingsMeta";

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  requiresStore?: boolean;
  badge?: "new" | "amber";
};

const mainItems: NavItem[] = [
  { href: "/", label: "Home", icon: Home },
  { href: "/bulk", label: "Bulk", icon: Layers },
  { href: "/product-finder", label: "Product Finder", icon: Search, badge: "amber" },
  { href: "/orders", label: "Orders", icon: ClipboardList },
  { href: "/listings", label: "Listing", icon: List, requiresStore: true },
  {
    href: "/settings",
    label: "Store Settings",
    icon: Settings,
    requiresStore: true,
  },
  { href: "/messages", label: "Messages", icon: Mail },
  { href: "/billing", label: "Billing", icon: CreditCard },
];

export function Sidebar() {
  const pathname = usePathname();
  const { activeStoreId, setActiveStoreId, bumpListingsVersion } = useAppStore();
  const [stores, setStores] = useState<Store[]>([]);
  const [connectOpen, setConnectOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const settingsBase = activeStoreId
    ? `/stores/${activeStoreId}/settings`
    : null;

  const listingsHref = activeStoreId
    ? `/stores/${activeStoreId}/listings`
    : null;

  const isSettingsPath =
    !!settingsBase && pathname.startsWith(settingsBase);

  const isListingsPath =
    !!listingsHref && pathname.startsWith(listingsHref);

  useEffect(() => {
    if (isSettingsPath) setSettingsOpen(true);
  }, [isSettingsPath]);

  const loadStores = async () => {
    const data = await getStores();
    setStores(data);
    if (!activeStoreId && data[0]?.id) setActiveStoreId(data[0].id);
    if (activeStoreId && !data.some((s) => s.id === activeStoreId)) {
      setActiveStoreId(data[0]?.id || null);
    }
  };

  useEffect(() => {
    loadStores().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resolveHref = (it: NavItem) => {
    if (it.label === "Listing" && listingsHref) return listingsHref;
    if (it.label === "Store Settings") return settingsBase || "/settings";
    if (it.requiresStore && !activeStoreId) return "/settings";
    return it.href;
  };

  const isActive = (it: NavItem) => {
    if (it.label === "Store Settings") return isSettingsPath;
    if (it.label === "Listing") return isListingsPath;
    return pathname === it.href;
  };

  const activeStore = stores.find((s) => s.id === activeStoreId);

  return (
    <aside className="flex h-screen w-[220px] shrink-0 flex-col border-r border-border bg-surface">
      <div className="border-b border-border px-4 py-4">
        <Link href="/" className="mb-4 flex items-center gap-2.5 group">
          <div className="flex h-[26px] w-[26px] items-center justify-center rounded-[6px] bg-accent text-white transition-transform duration-100 group-hover:scale-[1.02]">
            <span className="font-mono text-[11px] font-medium">D</span>
          </div>
          <div className="min-w-0">
            <span className="block text-[14px] font-medium text-text-1">
              Dropkanzi
            </span>
            <span className="block truncate text-[11px] text-text-3">
              {activeStore?.ebayUsername ?? "demo-store"}
            </span>
          </div>
        </Link>

        <div className="space-y-3">
          <div>
            <p className="label-caps mb-1.5">Store</p>
            <p className="mb-2 truncate text-[14px] font-medium text-text-primary">
              {activeStore?.ebayUsername ?? "No store"}
            </p>
            <div className="flex gap-1.5">
              <Select
                className="min-w-0 flex-1 text-xs"
                value={activeStoreId || ""}
                onChange={(e) => setActiveStoreId(e.target.value || null)}
              >
                <option value="" disabled>
                  Select…
                </option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.ebayUsername}
                  </option>
                ))}
              </Select>
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0 px-2"
                onClick={() => setConnectOpen(true)}
                type="button"
              >
                +
              </Button>
            </div>
          </div>

          <Button
            className="w-full"
            variant="primary"
            onClick={() => setAddOpen(true)}
            type="button"
          >
            <Plus className="h-3.5 w-3.5" />
            Add product
          </Button>
        </div>
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto p-2 pl-4">
        {mainItems.map((it) => {
          if (it.label === "Store Settings") {
            const Icon = it.icon;
            const hubActive = pathname === settingsBase;
            return (
              <div key={it.label}>
                <div className="flex items-center gap-0.5">
                  <Link
                    href={resolveHref(it)}
                    className={cn(
                      "nav-link flex-1 min-w-0",
                      isSettingsPath && "nav-link-active"
                    )}
                  >
                    <Icon
                      className={cn(
                        "h-[15px] w-[15px] shrink-0",
                        isSettingsPath ? "text-text-primary" : "text-text-tertiary"
                      )}
                    />
                    <span>Store Settings</span>
                  </Link>
                  {activeStoreId && settingsBase ? (
                    <button
                      type="button"
                      aria-label={
                        settingsOpen ? "Collapse settings" : "Expand settings"
                      }
                      onClick={() => setSettingsOpen((o) => !o)}
                      className="rounded-md p-1.5 text-text-tertiary transition-colors duration-100 hover:bg-surface-elevated hover:text-text-primary"
                    >
                      <ChevronDown
                        className={cn(
                          "h-3.5 w-3.5 transition-transform duration-150",
                          settingsOpen && "rotate-180"
                        )}
                      />
                    </button>
                  ) : null}
                </div>

                {activeStoreId && settingsBase && settingsOpen ? (
                  <div className="ml-2 mt-1 space-y-3 border-l border-border-subtle pb-2 pl-2.5">
                    <Link
                      href={settingsBase}
                      className={cn(
                        "block rounded-md px-2 py-1.5 text-[12px] transition-colors duration-100",
                        hubActive
                          ? "bg-accent-bg font-medium text-accent"
                          : "text-text-2 hover:bg-surface-2"
                      )}
                    >
                      Overview
                    </Link>
                    {STORE_SETTINGS_GROUPS.map((group) => (
                      <div key={group.id}>
                        <div className="label-caps mb-1 px-2 opacity-80">
                          {group.title}
                        </div>
                        <ul className="space-y-0.5">
                          {STORE_SETTINGS_CATALOG.filter(
                            (s) => s.group === group.id
                          ).map((item) => {
                            const href = `${settingsBase}/${item.href}`;
                            const active = pathname === href;
                            return (
                              <li key={item.href}>
                                <Link
                                  href={href}
                                  className={cn(
                                    "block rounded-md px-2 py-1.5 text-[12px] leading-snug transition-colors duration-100",
                                    active
                                      ? "bg-accent-bg font-medium text-accent"
                                      : "text-text-2 hover:bg-surface-2"
                                  )}
                                >
                                  {item.label}
                                </Link>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          }

          const Icon = it.icon;
          const href = resolveHref(it);
          const active = isActive(it);
          const disabled = it.requiresStore && !activeStoreId;

          if (disabled && it.label === "Listing") return null;

          return (
            <Link
              key={it.label}
              href={href}
              className={cn("nav-link", active && "nav-link-active")}
            >
              <Icon
                className={cn(
                  "h-[15px] w-[15px] shrink-0",
                  active ? "text-accent" : "text-text-3"
                )}
              />
              <span className="min-w-0 flex-1">{it.label}</span>
              {it.badge === "amber" ? (
                <span className="badge badge-amber ml-auto">NEW</span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-border p-4">
        <div className="mb-3 flex items-center justify-between text-xs">
          <span className="text-text-3">Balance</span>
          <span className="font-mono tabular-nums text-text-1">$0.00</span>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="flex h-[26px] w-[26px] items-center justify-center rounded-full bg-surface-2 font-mono text-[11px] text-text-2">
            U
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-text-1">User</div>
            <div className="truncate text-[11px] text-text-3">account</div>
          </div>
        </div>
      </div>

      <ConnectEbayModal
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
        onConnected={async (storeId) => {
          await loadStores();
          setActiveStoreId(storeId);
        }}
      />
      <AddProductModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        storeId={activeStoreId}
        onPublished={() => bumpListingsVersion()}
      />
    </aside>
  );
}
