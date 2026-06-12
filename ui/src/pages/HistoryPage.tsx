import { useCallback, useEffect, useState } from "react";
import { SaleCard } from "../components/SaleCard";
import { EmptyState } from "../components/EmptyState";
import { api } from "../lib/api";
import type { Hunt, SaleSummary } from "../types";

export function HistoryPage() {
  const [sales, setSales] = useState<SaleSummary[]>([]);
  const [hunts, setHunts] = useState<Hunt[]>([]);
  const [noHunts, setNoHunts] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [salesResult, huntsResult] = await Promise.all([
        api.getHistory(),
        api.getHunts(),
      ]);

      setSales(salesResult.sales);
      setNoHunts(salesResult.noHunts);
      setHunts(huntsResult.hunts);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load history");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return <p className="text-sm text-gray-500">Loading history…</p>;
  }

  if (error) {
    return <p className="text-sm text-red-600">{error}</p>;
  }

  if (noHunts) {
    return (
      <EmptyState
        icon="🎯"
        title="No hunts yet"
        description="Create a hunt to see matching sales."
        actionLabel="Create a hunt"
        actionTo="/hunts"
      />
    );
  }

  if (sales.length === 0) {
    return (
      <EmptyState
        icon="📅"
        title="No past sales"
        description={`Checked ${hunts.map((hunt) => hunt.name).join(", ")}.`}
      />
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">History</h1>
      {sales.map((sale) => (
        <SaleCard key={sale.saleId} sale={sale} showPlanButton={false} />
      ))}
    </div>
  );
}
