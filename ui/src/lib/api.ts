import type {
  DiscoverResponse,
  Finding,
  FindingWithSale,
  Hunt,
  SaleSummary,
  SettingsResponse,
  StatusResponse,
} from "../types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(error.error ?? "Request failed");
  }

  return response.json() as Promise<T>;
}

export const api = {
  getMe: () => request<{ sub: string }>("/api/me"),
  getStatus: () => request<StatusResponse>("/api/status"),
  getSales: () =>
    request<{ sales: SaleSummary[]; noHunts: boolean }>("/api/sales"),
  getHistory: () =>
    request<{ sales: SaleSummary[]; noHunts: boolean }>("/api/sales/history"),
  getSale: (id: string) =>
    request<{
      sale: SaleSummary;
      findings: Finding[];
      matchedFindingCount: number;
      totalFindingCount: number;
    }>(`/api/sales/${id}`),
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
  streamChat: async (
    message: string,
    history: { role: "user" | "assistant"; content: string }[],
    onToken: (token: string) => void,
    onDone: () => void,
    onError: (err: string) => void,
  ) => {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history }),
    });
    if (!res.ok || !res.body) {
      onError(`HTTP ${res.status}`);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const line of text.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          const payload = JSON.parse(line.slice(6)) as {
            token?: string;
            done?: boolean;
            error?: string;
          };
          if (payload.error) { onError(payload.error); return; }
          if (payload.token) onToken(payload.token);
          if (payload.done) { onDone(); return; }
        } catch {
          // partial line
        }
      }
    }
    onDone();
  },
};
