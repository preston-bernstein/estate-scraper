import { useCallback, useEffect, useState } from "react";
import { SaleCard } from "../components/SaleCard";
import { EmptyState } from "../components/EmptyState";
import { api } from "../lib/api";
import type { Hunt, SaleSummary } from "../types";

export function BrowsePage() {
  const [sales, setSales] = useState<SaleSummary[]>([]);
  const [hunts, setHunts] = useState<Hunt[]>([]);
  const [planSaleIds, setPlanSaleIds] = useState<Set<string>>(new Set());
  const [noHunts, setNoHunts] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [salesResult, huntsResult, planResult] = await Promise.all([
        api.getSales(),
        api.getHunts(),
        api.getPlanSaleIds(),
      ]);

      setSales(salesResult.sales);
      setNoHunts(salesResult.noHunts);
      setHunts(huntsResult.hunts);
      setPlanSaleIds(new Set(planResult.saleIds));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sales");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleAddToPlan(saleId: string) {
    await api.addToPlan(saleId);
    setPlanSaleIds((current) => new Set([...current, saleId]));
  }

  if (loading) {
    return <p className="text-sm text-gray-500">Loading sales…</p>;
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
        icon="📭"
        title="Nothing matched this week"
        description={`Checked ${hunts.map((hunt) => hunt.name).join(", ")}. Try broader keywords.`}
      />
    );
  }

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Browse</h1>
      {sales.map((sale) => (
        <SaleCard
          key={sale.saleId}
          sale={sale}
          inPlan={planSaleIds.has(sale.saleId)}
          onAddToPlan={() => void handleAddToPlan(sale.saleId)}
        />
      ))}
    </div>
  );
}
