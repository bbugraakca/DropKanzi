"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Layout } from "@/components/layout/Layout";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { connectEbayStore, getEbayConfigStatus, getEbayOAuthUrl } from "@/lib/api";
import type { EbayConfigStatus } from "@/lib/api";
import { useAppStore } from "@/lib/store/appStore";

export default function EbayOAuthInner() {
  const router = useRouter();
  const params = useSearchParams();
  const setActiveStoreId = useAppStore((s) => s.setActiveStoreId);

  const code = params.get("code") || "";
  const error = params.get("error") || "";

  const [username, setUsername] = useState("");
  const [country, setCountry] = useState("US");
  const [loading, setLoading] = useState(false);
  const [config, setConfig] = useState<EbayConfigStatus | null>(null);

  useEffect(() => {
    getEbayConfigStatus()
      .then(setConfig)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (error) {
      const msg = decodeURIComponent(error);
      if (msg.includes("unauthorized_client") || msg.includes("OAuth client was not found")) {
        toast.error(
          "eBay OAuth client not found — set EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_REDIRECT_URI (RuName) in .env and restart backend."
        );
      } else {
        toast.error(msg);
      }
    }
  }, [error]);

  const startOAuth = async () => {
    try {
      const { url } = await getEbayOAuthUrl();
      window.location.href = url;
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "OAuth start failed");
    }
  };

  const finishConnect = async () => {
    if (!code) {
      toast.error("Missing OAuth code — start OAuth first");
      return;
    }
    setLoading(true);
    try {
      const store = await connectEbayStore({
        code,
        ebayUsername: username.trim() || undefined,
        country: country.trim() || "US",
      });
      setActiveStoreId(store.id);
      toast.success("Store connected ✓");
      router.replace(`/stores/${store.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Connect failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Layout title="Connect eBay" breadcrumb="Home / Stores / OAuth">
      <Card className="p-5 max-w-[720px]">
        {code ? (
          <div className="space-y-4">
            <div className="text-sm text-text-muted">
              OAuth successful. Enter your eBay username and confirm country, then finish.
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <div className="text-xs text-text-muted mb-1">eBay username</div>
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="batudeals"
                />
              </div>
              <div>
                <div className="text-xs text-text-muted mb-1">Country</div>
                <Select value={country} onChange={(e) => setCountry(e.target.value)}>
                  {["US", "GB", "DE", "FR", "IT", "ES", "CA", "AU"].map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <Button onClick={finishConnect} disabled={loading}>
              {loading ? "Connecting…" : "Finish connect"}
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {config && !config.ok ? (
              <div className="rounded-[6px] border border-danger/30 bg-[#FEF2F2] p-4 text-sm text-[#991B1B] space-y-3">
                <div className="font-medium">eBay ayarları sunucuda tanımlı değil</div>
                <ul className="list-disc pl-5 space-y-1">
                  {config.issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
                <div className="text-xs space-y-2 border-t border-danger/20 pt-3">
                  <p className="font-medium">Adım adım (bir kez yapılır):</p>
                  <ol className="list-decimal pl-5 space-y-1">
                    <li>
                      <a
                        className="underline"
                        href="https://developer.ebay.com/my/keys"
                        target="_blank"
                        rel="noreferrer"
                      >
                        developer.ebay.com → Keys
                      </a>{" "}
                      — Production veya Sandbox keyset aç.
                    </li>
                    <li>
                      <strong>App ID</strong> → <span className="font-mono">EBAY_CLIENT_ID</span>
                      <br />
                      <strong>Cert ID</strong> → <span className="font-mono">EBAY_CLIENT_SECRET</span>
                    </li>
                    <li>
                      User Tokens → <strong>RuName</strong> oluştur → Auth Accepted URL:{" "}
                      <span className="font-mono break-all">
                        http://localhost:3001/api/auth/ebay/callback
                      </span>
                      <br />
                      RuName metnini (http değil!) →{" "}
                      <span className="font-mono">EBAY_REDIRECT_URI</span>
                    </li>
                    <li>
                      Dosya: <span className="font-mono">c:\Dropkanzi\.env</span> — kaydet, sonra:{" "}
                      <span className="font-mono">docker compose up -d backend</span>
                    </li>
                  </ol>
                  <p>
                    Sandbox key kullanıyorsan: <span className="font-mono">EBAY_SANDBOX=true</span>
                  </p>
                </div>
              </div>
            ) : null}
            <div className="text-sm text-text-muted">
              Connect your eBay seller account. You will be redirected to eBay to authorize.
              {config?.sandbox ? (
                <span className="block mt-1 text-accent">Sandbox mode (EBAY_SANDBOX=true)</span>
              ) : null}
            </div>
            <Button onClick={startOAuth} disabled={config !== null && !config.ok}>
              Connect with eBay
            </Button>
          </div>
        )}
      </Card>
    </Layout>
  );
}
