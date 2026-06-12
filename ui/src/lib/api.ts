import type {
  Finding,
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
};
