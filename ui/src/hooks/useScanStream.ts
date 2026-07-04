import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "../lib/api";
import type { ScanStatusEvent, ScanEvent } from "../types";

export type SaleProgress = {
  saleId: string;
  saleIdx: number;
  title: string;
  totalImages: number;
  done: number;
  findings: number;
  status: "pending" | "analyzing" | "done" | "skipped";
  score?: number;
  analysisPhase?: string;
  oracleRequested?: boolean;
};

type ScanStreamState = {
  status: ScanStatusEvent | null;
  totalSales: number;
  sales: SaleProgress[];
  connected: boolean;
};

export function useScanStream(active: boolean) {
  const [state, setState] = useState<ScanStreamState>({
    status: null,
    totalSales: 0,
    sales: [],
    connected: false,
  });
  const abortRef = useRef<AbortController | null>(null);

  const connect = useCallback(() => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    // Every callback below checks this before touching state — streamScan's onDone
    // fires even when the read loop exits because of the abort() above, so without
    // this guard the just-superseded stream's onDone clobbers the new connection's
    // connected:true (banner flashes "disconnected" while events are still arriving).
    const isCurrent = () => abortRef.current === ac;

    setState({ status: null, totalSales: 0, sales: [], connected: true });

    api.streamScan(
      (s) => {
        if (!isCurrent()) return;
        setState((prev) => ({ ...prev, status: s }));
      },
      (e: ScanEvent) => {
        if (!isCurrent()) return;
        setState((prev) => {
          const sales = [...prev.sales];

          if (e.type === "sale_start") {
            const existing = sales.findIndex((s) => s?.saleId === e.saleId);
            const entry: SaleProgress = {
              saleId: e.saleId,
              saleIdx: e.saleIdx,
              title: e.title,
              totalImages: e.total,
              done: 0,
              findings: 0,
              status: "analyzing",
            };
            if (existing >= 0) {
              sales[existing] = entry;
            } else {
              sales.push(entry);
              sales.sort((a, b) => (a?.saleIdx ?? 0) - (b?.saleIdx ?? 0));
            }
            return { ...prev, totalSales: e.totalSales, sales };
          }

          if (e.type === "progress") {
            const idx = sales.findIndex((s) => s.saleId === e.saleId);
            if (idx >= 0) {
              sales[idx] = { ...sales[idx]!, done: e.done, findings: e.found };
            }
            return { ...prev, sales };
          }

          if (e.type === "oracle_request") {
            const idx = sales.findIndex((s) => s.saleId === e.saleId);
            if (idx >= 0) sales[idx] = { ...sales[idx]!, oracleRequested: true };
            return { ...prev, sales };
          }

          if (e.type === "sale_done") {
            const idx = sales.findIndex((s) => s.saleId === e.saleId);
            if (idx >= 0) {
              sales[idx] = {
                ...sales[idx]!,
                status: "done",
                done: e.imagesProcessed,
                findings: e.imagesWithFindings,
                score: e.saleScore,
                analysisPhase: e.analysisPhase,
              };
            }
            return { ...prev, sales };
          }

          if (e.type === "sale_skip") {
            const idx = sales.findIndex((s) => s.saleId === e.saleId);
            if (idx >= 0) sales[idx] = { ...sales[idx]!, status: "skipped" };
            return { ...prev, sales };
          }

          return prev;
        });
      },
      () => {
        if (!isCurrent()) return;
        setState((prev) => ({ ...prev, connected: false }));
      },
      () => {
        if (!isCurrent()) return;
        setState((prev) => ({ ...prev, connected: false }));
      },
      ac.signal,
    );
  }, []);

  useEffect(() => {
    if (!active) return;
    connect();
    return () => abortRef.current?.abort();
  }, [active, connect]);

  return { ...state, reconnect: connect };
}
