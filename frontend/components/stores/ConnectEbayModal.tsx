"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { createDemoStore, getEbayOAuthUrl } from "@/lib/api";
import { useAppStore } from "@/lib/store/appStore";

export function ConnectEbayModal({
  open,
  onClose,
  onConnected,
}: {
  open: boolean;
  onClose: () => void;
  onConnected?: (storeId: string) => void;
}) {
  const router = useRouter();
  const setActiveStoreId = useAppStore((s) => s.setActiveStoreId);

  const startDemo = async () => {
    try {
      const store = await createDemoStore("Demo Store");
      setActiveStoreId(store.id);
      onConnected?.(store.id);
      onClose();
      toast.success("Demo store ready — open Store Settings anytime");
      router.push(`/stores/${store.id}/settings`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Demo store failed");
    }
  };

  const startOAuth = async () => {
    try {
      const { url } = await getEbayOAuthUrl();
      onClose();
      window.location.href = url;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "OAuth failed");
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Connect eBay store">
      <div className="space-y-4">
        <div className="text-sm text-text-muted space-y-2">
          <p>
            <strong>No eBay yet?</strong> Use a demo store to configure repricing, tracking, and
            listing templates without OAuth.
          </p>
          <p>
            When ready, authorize on eBay (requires EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, and RuName
            in server <span className="font-mono text-xs">.env</span>).
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="secondary" onClick={startDemo}>
            Demo store (no eBay)
          </Button>
          <Button type="button" onClick={startOAuth}>
            Connect with eBay
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              onClose();
              router.push("/stores/oauth");
            }}
          >
            Manual setup
          </Button>
        </div>
      </div>
    </Modal>
  );
}
