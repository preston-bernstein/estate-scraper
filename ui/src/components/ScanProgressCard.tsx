import { useState, useRef, useEffect } from "react";
import { X, ChevronDown, ChevronUp, Zap } from "lucide-react";
import { useScanStream, type SaleProgress } from "../hooks/useScanStream";

function SaleRow({ sale }: { sale: SaleProgress }) {
  const pct = sale.totalImages > 0 ? Math.round((sale.done / sale.totalImages) * 100) : 0;
  const isActive = sale.status === "analyzing";
  const isDone = sale.status === "done";
  const isSkip = sale.status === "skipped";

  return (
    <div className={`py-2 px-3 border-b border-zinc-100 dark:border-zinc-800 last:border-0 ${isActive ? "bg-blue-50/50 dark:bg-blue-950/20" : ""}`}>
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex-none text-xs w-3 text-center">
          {isDone ? "✓" : isSkip ? "–" : isActive ? "●" : "○"}
        </span>
        <div className="flex-1 min-w-0">
          <p className={`text-xs font-medium truncate ${isDone ? "text-zinc-600 dark:text-zinc-400" : "text-zinc-900 dark:text-zinc-100"}`}>
            {sale.title}
          </p>
          {isActive && (
            <div className="mt-1 space-y-0.5">
              <div className="h-1 rounded-full bg-zinc-200 dark:bg-zinc-700 overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-300"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <p className="text-[10px] text-zinc-400">
                {sale.done}/{sale.totalImages} imgs
                {sale.findings > 0 && ` · ${sale.findings} found`}
                {sale.oracleRequested && " · oracle ⚡"}
              </p>
            </div>
          )}
          {isDone && (
            <p className="text-[10px] text-zinc-400">
              {sale.findings} finding{sale.findings !== 1 ? "s" : ""}
              {sale.score !== undefined && <> · score {sale.score.toFixed(1)}</>}
              {sale.oracleRequested && " · oracle ⚡"}
            </p>
          )}
          {isSkip && (
            <p className="text-[10px] text-zinc-400">nothing found</p>
          )}
        </div>
      </div>
    </div>
  );
}

type Props = {
  onClose: () => void;
};

export function ScanProgressCard({ onClose }: Props) {
  const [minimized, setMinimized] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const { status, totalSales, sales, connected } = useScanStream(true);

  const running = status?.running ?? false;
  const failed = status?.failed ?? false;
  const phase = status?.phase ?? "idle";
  const activeSale = sales.find((s) => s.status === "analyzing");
  const doneSales = sales.filter((s) => s.status === "done" || s.status === "skipped").length;

  // Auto-scroll to active sale
  useEffect(() => {
    if (!listRef.current || minimized) return;
    const active = listRef.current.querySelector('[data-active="true"]');
    active?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeSale?.saleId, minimized]);

  const headerLabel = failed
    ? "Scan failed"
    : !running && phase === "done"
    ? "Scan complete"
    : phase === "scraping"
    ? "Scraping listings…"
    : activeSale
    ? `Sale ${activeSale.saleIdx + 1} of ${totalSales || "?"}`
    : connected
    ? "Connecting…"
    : "Scan running";

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 rounded-2xl shadow-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 overflow-hidden">
      {/* Header */}
      <div className={`flex items-center gap-2 px-3 py-2.5 ${failed ? "bg-red-50 dark:bg-red-950/30" : "bg-zinc-50 dark:bg-zinc-800"}`}>
        <span className="flex-none">
          {failed ? (
            <span className="text-red-500 text-sm">✕</span>
          ) : running ? (
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
            </span>
          ) : (
            <span className="text-green-500 text-sm">✓</span>
          )}
        </span>
        <span className={`flex-1 text-xs font-semibold ${failed ? "text-red-700 dark:text-red-400" : "text-zinc-700 dark:text-zinc-300"}`}>
          {headerLabel}
        </span>
        {totalSales > 0 && !minimized && (
          <span className="text-[10px] text-zinc-400">
            {doneSales}/{totalSales}
          </span>
        )}
        <button
          onClick={() => setMinimized((v) => !v)}
          className="p-0.5 rounded text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
        >
          {minimized ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        <button
          onClick={onClose}
          className="p-0.5 rounded text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
        >
          <X size={14} />
        </button>
      </div>

      {/* Sale list */}
      {!minimized && (
        <div ref={listRef} className="max-h-72 overflow-y-auto">
          {sales.length === 0 && (
            <p className="text-xs text-zinc-400 text-center py-4">
              {connected ? "Waiting for sales…" : "Connecting…"}
            </p>
          )}
          {sales.map((sale) => (
            <div key={sale.saleId} data-active={sale.status === "analyzing"}>
              <SaleRow sale={sale} />
            </div>
          ))}
        </div>
      )}

      {/* Footer — oracle legend if any */}
      {!minimized && sales.some((s) => s.oracleRequested) && (
        <div className="px-3 py-1.5 border-t border-zinc-100 dark:border-zinc-800 flex items-center gap-1">
          <Zap size={10} className="text-amber-500" />
          <span className="text-[10px] text-zinc-400">Claude oracle called</span>
        </div>
      )}
    </div>
  );
}
