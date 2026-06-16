"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { BulkJobListingsPanel } from "@/components/bulk/BulkJobListingsPanel";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { getJob, listBulkJobs } from "@/lib/api";
import { formatBytes } from "@/lib/formatBytes";
import type { ScrapeJob } from "@/lib/types";
import { cn } from "@/lib/utils";

function statusColor(status: string) {
  if (status === "done") return "text-success bg-emerald-50";
  if (status === "failed") return "text-danger bg-dangerLight";
  if (status === "running") return "text-accent bg-accent-light";
  return "text-text-body bg-surface-muted";
}

export function BulkStatusPanel({
  highlightJobId,
  autoRefresh,
}: {
  highlightJobId?: string | null;
  autoRefresh?: boolean;
}) {
  const [jobs, setJobs] = useState<ScrapeJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [bytesByJob, setBytesByJob] = useState<Record<string, number>>({});

  const jobsRef = useRef<ScrapeJob[]>([]);
  jobsRef.current = jobs;

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(jobsRef.current.length === 0);
    try {
      const data = await listBulkJobs();
      setJobs(data);
      const bytes: Record<string, number> = {};
      for (const j of data) {
        if (j.totalBytesDownloaded && j.totalBytesDownloaded > 0) {
          bytes[j.id] = j.totalBytesDownloaded;
          continue;
        }
        const stats = j.itemStats ?? {};
        const sum = Object.values(stats).reduce(
          (s, st) => s + (st.bytesDownloaded || 0),
          0
        );
        if (sum > 0) bytes[j.id] = sum;
      }
      setBytesByJob(bytes);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load jobs");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (highlightJobId) setSelectedJobId(highlightJobId);
  }, [highlightJobId]);

  useEffect(() => {
    if (!autoRefresh) return;
    const hasRunning = jobs.some((j) => j.status === "running" || j.status === "pending");
    if (!hasRunning) return;
    const t = setInterval(() => void load({ silent: true }), 2000);
    return () => clearInterval(t);
  }, [autoRefresh, jobs, load]);

  useEffect(() => {
    if (!highlightJobId) return;
    const poll = async () => {
      try {
        await getJob(highlightJobId);
        await load({ silent: jobsRef.current.length > 0 });
      } catch {
        // ignore
      }
    };
    poll();
    const t = setInterval(poll, 800);
    return () => clearInterval(t);
  }, [highlightJobId, load]);

  const toggleJob = (id: string) => {
    setSelectedJobId((prev) => (prev === id ? null : id));
  };

  return (
    <Card className="min-h-[480px] p-6">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <div className="text-sm font-semibold text-text-primary">Bulk status</div>
          <div className="text-sm text-text-muted">
            Recent Amazon scrape jobs — click a row for listing details
          </div>
        </div>
        <Button
          variant="secondary"
          type="button"
          onClick={() => void load({ silent: jobs.length > 0 })}
          disabled={loading && jobs.length === 0}
        >
          <RefreshCw className={`w-4 h-4 ${loading && jobs.length === 0 ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <div className="relative min-h-[320px]">
        {loading && jobs.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-sm text-text-muted">
            Loading…
          </div>
        ) : jobs.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-sm text-text-muted">
            No bulk jobs yet. Start a bulk scrape above.
          </div>
        ) : (
          <>
            {loading ? (
              <div
                className="pointer-events-none absolute inset-0 z-10 flex items-start justify-center bg-surface/40 pt-8"
                aria-hidden
              >
                <RefreshCw className="h-5 w-5 animate-spin text-text-muted" />
              </div>
            ) : null}
            <div className="overflow-auto">
            <table className="min-w-[640px] w-full text-sm">
              <thead className="text-xs text-text-muted border-b border-border">
                <tr>
                  <th className="w-8 py-2" />
                  <th className="text-left py-2 pr-3">Job ID</th>
                  <th className="text-left py-2 pr-3">Status</th>
                  <th className="text-left py-2 pr-3">Progress</th>
                  <th className="text-left py-2 pr-3">OK</th>
                  <th className="text-left py-2 pr-3">Failed</th>
                  <th className="text-left py-2 pr-3">Total</th>
                  <th className="text-left py-2 pr-3">Download</th>
                  <th className="text-left py-2">Started</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {jobs.map((j) => {
                  const open = selectedJobId === j.id;
                  return (
                    <tr
                      key={j.id}
                      onClick={() => toggleJob(j.id)}
                      className={cn(
                        "cursor-pointer hover:bg-surface/80 transition-colors",
                        open && "bg-accent-light/50",
                        j.id === highlightJobId && !open && "bg-surface-muted"
                      )}
                    >
                      <td className="py-3 pl-1 text-text-muted">
                        {open ? (
                          <ChevronDown className="w-4 h-4" />
                        ) : (
                          <ChevronRight className="w-4 h-4" />
                        )}
                      </td>
                      <td className="py-3 pr-3 font-mono text-xs">{j.id.slice(0, 12)}…</td>
                      <td className="py-3 pr-3">
                        <span
                          className={`inline-flex px-2 py-0.5 rounded-full text-xs capitalize ${statusColor(j.status)}`}
                        >
                          {j.status}
                        </span>
                      </td>
                      <td className="py-3 pr-3">
                        <div className="flex items-center gap-2 min-w-[120px]">
                          <div className="flex-1 h-1.5 rounded-full bg-surface border border-border overflow-hidden">
                            <div
                              className="h-full bg-accent"
                              style={{ width: `${j.percent ?? 0}%` }}
                            />
                          </div>
                          <span className="text-xs text-text-muted w-8">{j.percent ?? 0}%</span>
                        </div>
                      </td>
                      <td className="py-3 pr-3">{j.done}</td>
                      <td className="py-3 pr-3">{j.failed}</td>
                      <td className="py-3 pr-3">{j.total}</td>
                      <td
                        className="py-3 pr-3 font-mono text-xs text-text-body whitespace-nowrap"
                        title={
                          (bytesByJob[j.id] ?? j.totalBytesDownloaded ?? 0) > 0
                            ? `${(bytesByJob[j.id] ?? j.totalBytesDownloaded ?? 0).toLocaleString()} bytes`
                            : "Run a new bulk scrape after deploy to record bandwidth"
                        }
                      >
                        {(() => {
                          const b =
                            bytesByJob[j.id] ?? j.totalBytesDownloaded ?? 0;
                          return b > 0 ? formatBytes(b) : "—";
                        })()}
                      </td>
                      <td className="py-3 text-text-muted text-xs">
                        {j.createdAt ? new Date(j.createdAt).toLocaleString() : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {selectedJobId ? (
            <BulkJobListingsPanel
              jobId={selectedJobId}
              onClose={() => setSelectedJobId(null)}
              onTotalBytes={(id, bytes) =>
                setBytesByJob((prev) => ({ ...prev, [id]: bytes }))
              }
            />
          ) : null}
          </>
        )}
      </div>
    </Card>
  );
}
