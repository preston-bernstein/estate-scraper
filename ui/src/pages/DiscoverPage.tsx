import { use, Suspense, useState, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { X } from "lucide-react";
import { api } from "../lib/api";
import { cached } from "../lib/cache";
import { CategoryStrip, type Category } from "../components/CategoryStrip";
import { StandoutScroll } from "../components/StandoutScroll";
import { RankedSaleCard } from "../components/RankedSaleCard";
import type { RankedSale } from "../types";

function totalCounts(sales: RankedSale[]): Record<Category, number> {
  const counts = { all: 0, electronics: 0, kitsch: 0, collectible: 0, furniture: 0 };
  for (const s of sales) {
    counts.electronics += s.tally.electronics;
    counts.kitsch += s.tally.kitsch;
    counts.collectible += s.tally.collectibles;
    counts.furniture += s.tally.furniture;
    counts.all += s.totalFindings;
  }
  return counts;
}

function filterByCategory(sales: RankedSale[], category: Category): RankedSale[] {
  if (category === "all") return sales;
  return sales.filter((s) => {
    if (category === "electronics") return s.tally.electronics > 0;
    if (category === "kitsch") return s.tally.kitsch > 0;
    if (category === "collectible") return s.tally.collectibles > 0;
    if (category === "furniture") return s.tally.furniture > 0;
    return true;
  });
}

function DiscoverContent() {
  const [category, setCategory] = useState<Category>("all");
  const data = use(cached("discover", api.getDiscover));

  const counts = totalCounts(data.rankedSales);
  const filtered = filterByCategory(data.rankedSales, category);

  const standouts =
    category === "all"
      ? data.standouts
      : data.standouts.filter(
          (s) => s.tag === category || (category === "collectible" && s.tag === "collectible"),
        );

  return (
    <div className="space-y-6">
      <CategoryStrip active={category} counts={counts} onChange={setCategory} />

      {standouts.length > 0 && <StandoutScroll standouts={standouts.slice(0, 12)} />}

      {filtered.length === 0 ? (
        <p className="text-zinc-400 text-sm py-8 text-center">No sales found for this category.</p>
      ) : (
        <section className="space-y-4">
          <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
            {filtered.length} sale{filtered.length !== 1 ? "s" : ""} ranked by score
          </h2>
          {filtered.map((sale, i) => (
            <RankedSaleCard key={sale.saleId} sale={sale} rank={i + 1} filter={category} />
          ))}
        </section>
      )}
    </div>
  );
}

function SearchContent({ searchQuery }: { searchQuery: string }) {
  const data = use(cached("search:" + searchQuery, () => api.searchSales(searchQuery)));

  if (data.sales.length === 0) {
    return (
      <p className="text-zinc-400 text-sm py-8 text-center">
        No findings match "{searchQuery}".
      </p>
    );
  }

  return (
    <section className="space-y-4">
      <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider">
        {data.sales.length} sale{data.sales.length !== 1 ? "s" : ""} with findings for "{searchQuery}"
      </h2>
      {data.sales.map((sale, i) => (
        <RankedSaleCard key={sale.saleId} sale={sale} rank={i + 1} filter="all" />
      ))}
    </section>
  );
}

function DiscoverSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="flex gap-2">
        {[80, 110, 90, 100, 80].map((w, i) => (
          <div key={i} className="h-8 rounded-full bg-zinc-100 dark:bg-zinc-800" style={{ width: w }} />
        ))}
      </div>
      <div className="flex gap-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex-none w-44 space-y-2">
            <div className="aspect-square rounded-xl bg-zinc-100 dark:bg-zinc-800" />
            <div className="h-3 rounded bg-zinc-100 dark:bg-zinc-800 w-3/4" />
          </div>
        ))}
      </div>
      {[0, 1, 2].map((i) => (
        <div key={i} className="border border-zinc-200 dark:border-zinc-800 rounded-2xl p-4 space-y-3">
          <div className="h-4 rounded bg-zinc-100 dark:bg-zinc-800 w-2/3" />
          <div className="h-3 rounded bg-zinc-100 dark:bg-zinc-800 w-1/2" />
          <div className="flex gap-2">
            {[0, 1, 2].map((j) => (
              <div key={j} className="w-24 aspect-square rounded-lg bg-zinc-100 dark:bg-zinc-800" />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function DiscoverPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const searchQuery = searchParams.get("q") ?? "";
  const [inputValue, setInputValue] = useState(searchQuery);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function handleSearch(value: string) {
    setInputValue(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setSearchParams(value.trim() ? { q: value.trim() } : {}, { replace: true });
    }, 150);
  }

  function clearSearch() {
    setInputValue("");
    clearTimeout(debounceRef.current);
    setSearchParams({}, { replace: true });
  }

  return (
    <div className="max-w-2xl mx-auto px-4 pt-4 pb-6 space-y-4">
      {/* Search bar renders immediately — lives outside Suspense boundary */}
      <div className="relative">
        <input
          type="text"
          value={inputValue}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="Search sales, items, cities…"
          className="w-full rounded-full border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-4 py-2.5 pr-9 text-sm text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-shadow"
        />
        {inputValue && (
          <button
            onClick={clearSearch}
            aria-label="Clear search"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
          >
            <X size={15} />
          </button>
        )}
      </div>

      <Suspense fallback={<DiscoverSkeleton />}>
        {searchQuery.trim() ? (
          <SearchContent searchQuery={searchQuery.trim()} />
        ) : (
          <DiscoverContent />
        )}
      </Suspense>
    </div>
  );
}
