import type {
  AllItem,
  AnalyzedImage,
  DiscoverResponse,
  Finding,
  FindingWithSale,
  Hunt,
  RankedSale,
  SaleSummary,
  ScanEvent,
  ScanStatusEvent,
  SettingsResponse,
  StatusResponse,
} from "../types";
import { userManager } from "./auth";

async function authHeader(): Promise<Record<string, string>> {
  if (!userManager) return {};
  const user = await userManager.getUser();
  if (!user?.access_token) return {};
  return { Authorization: `Bearer ${user.access_token}` };
}

// Shared fetch→reader→decoder→line-buffer loop for streamScan and streamChat, which
// otherwise hand-rolled the identical partial-line-buffering logic — a fix to one
// wouldn't reach the other. `onLine` gets each complete line as it arrives; the
// trailing partial line (mid-chunk) is held back until more data completes it.
async function readLines(
  response: Response,
  // Return false to stop reading early (e.g. a terminal "done"/"error" payload).
  onLine: (line: string) => boolean | void,
): Promise<void> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  outer: while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      break;
    }
    if (chunk.done) break;
    buf += decoder.decode(chunk.value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (onLine(line) === false) break outer;
    }
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(await authHeader()),
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (response.status === 401) {
    userManager?.removeUser().catch(() => {});
    throw new Error("Unauthorized");
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error ?? "Request failed");
  }

  return response.json() as Promise<T>;
}

export const api = {
  getMe: () => request<{ sub: string; canTriggerScan: boolean }>("/api/me"),
  getStatus: () => request<StatusResponse>("/api/status"),
  getSales: () =>
    request<{ sales: SaleSummary[]; noHunts: boolean }>("/api/sales"),
  getAllSales: () =>
    request<{ sales: SaleSummary[]; noHunts: boolean }>("/api/sales/all"),
  getAllItems: () => request<{ items: AllItem[] }>("/api/findings/all"),
  getHistory: () =>
    request<{ sales: SaleSummary[]; noHunts: boolean }>("/api/sales/history"),
  getSale: (id: string) =>
    request<{
      sale: SaleSummary;
      findings: Finding[];
      matchedFindingCount: number;
      totalFindingCount: number;
    }>(`/api/sales/${id}`),
  getSaleImages: (id: string) =>
    request<{ images: AnalyzedImage[] }>(`/api/sales/${id}/images`),
  getOutcome: (saleId: string) =>
    request<{
      outcome: {
        attended: boolean;
        outcome: "good" | "meh" | "waste";
        notes: string | null;
      } | null;
    }>(`/api/sales/${saleId}/outcome`),
  recordOutcome: (
    saleId: string,
    attended: boolean,
    outcome: "good" | "meh" | "waste",
    notes?: string,
  ) =>
    request<{ ok: boolean }>(`/api/sales/${saleId}/outcome`, {
      method: "POST",
      body: JSON.stringify({ attended, outcome, notes }),
    }),
  getHunts: () => request<{ hunts: Hunt[] }>("/api/hunts"),
  createHunt: (name: string, keywords: string[]) =>
    request<{ hunt: Hunt }>("/api/hunts", {
      method: "POST",
      body: JSON.stringify({ name, keywords }),
    }),
  updateHunt: (id: number, data: { name?: string; keywords?: string[] }) =>
    request<{ hunt: Hunt }>(`/api/hunts/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  deleteHunt: (id: number) =>
    request<{ ok: boolean }>(`/api/hunts/${id}`, { method: "DELETE" }),
  getSettings: () => request<SettingsResponse>("/api/settings"),
  updateSettings: (radiusMiles: number) =>
    request<SettingsResponse>("/api/settings", {
      method: "PUT",
      body: JSON.stringify({ radiusMiles }),
    }),
  getPlan: () => request<{ items: SaleSummary[] }>("/api/plan"),
  getPlanSaleIds: () => request<{ saleIds: string[] }>("/api/plan/sale-ids"),
  addToPlan: (saleId: string) =>
    request("/api/plan", {
      method: "POST",
      body: JSON.stringify({ saleId }),
    }),
  removeFromPlan: (saleId: string) =>
    request(`/api/plan/${saleId}`, { method: "DELETE" }),
  reorderPlan: (saleIds: string[]) =>
    request("/api/plan/reorder", {
      method: "PUT",
      body: JSON.stringify({ saleIds }),
    }),
  searchFindings: (keywords: string[]) =>
    request<{ findings: FindingWithSale[] }>(
      `/api/findings?q=${encodeURIComponent(keywords.join(","))}`,
    ),
  getDiscover: () => request<DiscoverResponse>("/api/discover"),
  searchSales: (query: string) =>
    request<{ sales: RankedSale[] }>(
      `/api/discover/search?q=${encodeURIComponent(query)}`,
    ),
  startScan: () =>
    request<{ started: boolean; reason?: string }>("/api/scan/start", { method: "POST" }),

  streamScan: async (
    onStatus: (s: ScanStatusEvent) => void,
    onEvent: (e: ScanEvent) => void,
    onDone: () => void,
    onError: (err: string) => void,
    signal?: AbortSignal,
  ) => {
    let res: Response;
    try {
      res = await fetch("/api/scan/stream", {
        headers: { ...(await authHeader()) },
        signal,
      });
    } catch {
      onDone();
      return;
    }
    if (!res.ok || !res.body) { onError(`HTTP ${res.status}`); return; }
    let eventType = "";
    await readLines(res, (line) => {
      if (line.startsWith("event: ")) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith("data: ")) {
        try {
          const data = JSON.parse(line.slice(6)) as Record<string, unknown>;
          if (eventType === "status") onStatus(data as unknown as ScanStatusEvent);
          else if (eventType === "scan") onEvent(data as unknown as ScanEvent);
        } catch { /* partial */ }
        eventType = "";
      }
    });
    onDone();
  },

  streamChat: async (
    message: string,
    history: { role: "user" | "assistant"; content: string }[],
    onToken: (token: string) => void,
    onDone: () => void,
    onError: (err: string) => void,
  ) => {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeader()) },
      body: JSON.stringify({ message, history }),
    });
    if (!res.ok || !res.body) {
      onError(`HTTP ${res.status}`);
      return;
    }
    let finished = false;
    await readLines(res, (line) => {
      if (!line.startsWith("data: ")) return;
      try {
        const payload = JSON.parse(line.slice(6)) as {
          token?: string;
          done?: boolean;
          error?: string;
        };
        if (payload.error) {
          onError(payload.error);
          finished = true;
          return false;
        }
        if (payload.token) onToken(payload.token);
        if (payload.done) {
          onDone();
          finished = true;
          return false;
        }
      } catch {
        // partial line
      }
    });
    if (!finished) onDone();
  },
};
