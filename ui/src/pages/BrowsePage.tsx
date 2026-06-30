import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { SaleCard } from "../components/SaleCard";
import { ErrorState, LoadingState } from "../components/states";
import { friendlyMessage } from "../components/ErrorBoundary";
import { api } from "../lib/api";
import type { AllItem, SaleSummary } from "../types";

type View = "upcoming" | "all" | "items";

const TABS: { id: View; label: string }[] = [
  { id: "upcoming", label: "Upcoming" },
  { id: "all", label: "All sales" },
  { id: "items", label: "All items" },
];

export function BrowsePage() {
  const [view, setView] = useState<View>("upcoming");
  const [sales, setSales] = useState<SaleSummary[]>([]);
  const [items, setItems] = useState<AllItem[]>([]);
  const [planSaleIds, setPlanSaleIds] = useState<Set<string>>(new Set());
  const [noHunts, setNoHunts] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (v: View) => {
    setLoading(true);
    setError(null);
    try {
      if (v === "items") {
        const { items: result } = await api.getAllItems();
        setItems(result);
      } else {
        const [salesResult, planResult] = await Promise.all([
          v === "all" ? api.getAllSales() : api.getSales(),
          api.getPlanSaleIds(),
        ]);
        setSales(salesResult.sales);
        setNoHunts(salesResult.noHunts);
        setPlanSaleIds(new Set(planResult.saleIds));
      }
    } catch (err) {
      setError(friendlyMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(view);
  }, [load, view]);

  async function handleAddToPlan(saleId: string) {
    await api.addToPlan(saleId);
    setPlanSaleIds((current) => new Set([...current, saleId]));
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">Browse</h1>
        <div className="inline-flex rounded-full bg-zinc-100 p-0.5 dark:bg-zinc-800">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setView(tab.id)}
              className={`rounded-full px-3 py-1 text-sm transition-colors ${
                view === tab.id
                  ? "bg-white shadow-sm dark:bg-zinc-700"
                  : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* No-Hunts hint — sales are shown anyway, this just nudges toward filtering. */}
      {view !== "items" && noHunts && (
        <p className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800 dark:bg-blue-950/40 dark:text-blue-300">
          Showing every {view === "all" ? "sale" : "upcoming sale"} —{" "}
          <Link to="/hunts" className="font-medium underline">
            create a Hunt
          </Link>{" "}
          to filter to what you collect.
        </p>
      )}

      {loading && <LoadingState />}
      {error && <ErrorState message={error} onRetry={() => void load(view)} />}

      {!loading && !error && view === "items" && (
        items.length === 0 ? (
          <p className="text-sm text-zinc-500">No items found yet.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {items.map((item) => (
              <Link
                key={item.id}
                to={`/sales/${item.saleId}`}
                className="group overflow-hidden rounded-xl bg-white shadow-sm dark:bg-zinc-800"
              >
                <img
                  src={item.imageUrl}
                  alt={item.description}
                  loading="lazy"
                  className="aspect-square w-full object-cover"
                />
                <p className="line-clamp-2 px-2 py-1.5 text-xs text-zinc-700 dark:text-zinc-300">
                  {item.description}
                </p>
              </Link>
            ))}
          </div>
        )
      )}

      {!loading && !error && view !== "items" && (
        sales.length === 0 ? (
          <p className="text-sm text-zinc-500">
            {view === "all" ? "No sales in the corpus yet." : "No upcoming sales right now."}
          </p>
        ) : (
          sales.map((sale) => (
            <SaleCard
              key={sale.saleId}
              sale={sale}
              inPlan={planSaleIds.has(sale.saleId)}
              onAddToPlan={() => void handleAddToPlan(sale.saleId)}
            />
          ))
        )
      )}
    </div>
  );
}
