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

export type ScanStreamState = {
  status: ScanStatusEvent | null;
  totalSales: number;
  sales: SaleProgress[];
  connected: boolean;
};

type SaleStartEvent = Extract<ScanEvent, { type: "sale_start" }>;
type ProgressEvent = Extract<ScanEvent, { type: "progress" }>;
type SaleDoneEvent = Extract<ScanEvent, { type: "sale_done" }>;
type SaleSkipEvent = Extract<ScanEvent, { type: "sale_skip" }>;
type OracleRequestEvent = Extract<ScanEvent, { type: "oracle_request" }>;

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

    setState({ status: null, totalSales: 0, sales: [], connected: true });

    api.streamScan(
      (s) => setState((prev) => ({ ...prev, status: s })),
      (e: ScanEvent) => {
        setState((prev) => {
          const sales = [...prev.sales];

          if (e.type === "sale_start") {
            const ev = e as SaleStartEvent;
            const existing = sales.findIndex((s) => s?.saleId === ev.saleId);
            const entry: SaleProgress = {
              saleId: ev.saleId,
              saleIdx: ev.saleIdx,
              title: ev.title,
              totalImages: ev.total,
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
            return { ...prev, totalSales: ev.totalSales, sales };
          }

          if (e.type === "progress") {
            const ev = e as ProgressEvent;
            const idx = sales.findIndex((s) => s.saleId === ev.saleId);
            if (idx >= 0) {
              sales[idx] = { ...sales[idx]!, done: ev.done, findings: ev.found };
            }
            return { ...prev, sales };
          }

          if (e.type === "oracle_request") {
            const ev = e as OracleRequestEvent;
            const idx = sales.findIndex((s) => s.saleId === ev.saleId);
            if (idx >= 0) sales[idx] = { ...sales[idx]!, oracleRequested: true };
            return { ...prev, sales };
          }

          if (e.type === "sale_done") {
            const ev = e as SaleDoneEvent;
            const idx = sales.findIndex((s) => s.saleId === ev.saleId);
            if (idx >= 0) {
              sales[idx] = {
                ...sales[idx]!,
                status: "done",
                done: ev.imagesProcessed,
                findings: ev.imagesWithFindings,
                score: ev.saleScore,
                analysisPhase: ev.analysisPhase,
              };
            }
            return { ...prev, sales };
          }

          if (e.type === "sale_skip") {
            const ev = e as SaleSkipEvent;
            const idx = sales.findIndex((s) => s.saleId === ev.saleId);
            if (idx >= 0) sales[idx] = { ...sales[idx]!, status: "skipped" };
            return { ...prev, sales };
          }

          return prev;
        });
      },
      () => setState((prev) => ({ ...prev, connected: false })),
      () => setState((prev) => ({ ...prev, connected: false })),
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
