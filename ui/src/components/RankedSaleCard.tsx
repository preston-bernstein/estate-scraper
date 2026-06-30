import { Link } from "react-router-dom";
import type { RankedSale } from "../types";
import { cn } from "../lib/utils";
import type { Category } from "./CategoryStrip";
import { ResilientImage } from "./ResilientImage";

function daysLeft(endDate: string): number {
  const end = new Date(endDate);
  const now = new Date();
  return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86_400_000));
}

function formatDate(d: string) {
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const TAG_PILL: Record<string, string> = {
  electronics: "bg-blue-500/10 text-blue-400",
  kitsch: "bg-pink-500/10 text-pink-400",
  collectible: "bg-amber-500/10 text-amber-400",
  furniture: "bg-zinc-500/10 text-zinc-400",
};

type Props = {
  sale: RankedSale;
  rank: number;
  filter: Category;
};

export function RankedSaleCard({ sale, rank, filter }: Props) {
  const left = daysLeft(sale.endDate);
  const findings =
    filter === "all"
      ? sale.topFindings
      : sale.topFindings.filter((f) => f.tag === filter || (filter === "collectible" && f.tag === "collectible"));

  const displayed = findings.slice(0, 5);

  const hasElectronics = sale.tally.electronics > 0;
  const hasKitsch = sale.tally.kitsch > 0;

  return (
    <article className="bg-white dark:bg-zinc-900 rounded-2xl p-4 shadow-sm hover:shadow-md transition-shadow duration-200 border border-zinc-100 dark:border-zinc-800/60">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-xs font-mono text-zinc-400 shrink-0">#{rank}</span>
          <Link
            to={`/sales/${sale.saleId}`}
            className="font-semibold text-zinc-900 dark:text-zinc-50 hover:text-blue-500 dark:hover:text-blue-400 transition-colors truncate"
          >
            {sale.title}
          </Link>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {hasElectronics && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-500/10 text-blue-400 font-medium">
              Electronics
            </span>
          )}
          {hasKitsch && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-pink-500/10 text-pink-400 font-medium">
              Kitsch
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 text-xs text-zinc-500 dark:text-zinc-400 mb-3">
        <span>{sale.distanceMiles.toFixed(1)}mi</span>
        <span>·</span>
        <span>{formatDate(sale.startDate)}–{formatDate(sale.endDate)}</span>
        <span>·</span>
        <span className={cn(left <= 1 ? "text-red-400 font-medium" : "")}>
          {left === 0 ? "ends today" : left === 1 ? "1 day left" : `${left} days left`}
        </span>
        <span>·</span>
        <span>{sale.totalFindings} finds</span>
      </div>

      {displayed.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar mb-3">
          {displayed.map((f) => (
            <div key={f.id} className="group/thumb flex-none w-24">
              <div className="aspect-square rounded-lg overflow-hidden bg-zinc-100 dark:bg-zinc-800 relative mb-1">
                <ResilientImage
                  srcs={[f.thumbUrl, f.imageUrl]}
                  alt={f.description}
                  className="w-full h-full object-cover group-hover/thumb:scale-105 transition-transform duration-300"
                />
                <span
                  className={cn(
                    "absolute bottom-0.5 right-0.5 text-[9px] px-1 py-px rounded-sm",
                    TAG_PILL[f.tag] ?? TAG_PILL.furniture,
                  )}
                >
                  {f.tag[0].toUpperCase()}
                </span>
              </div>
              <p className="text-[10px] text-zinc-500 dark:text-zinc-400 line-clamp-2 leading-tight">
                {f.description}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between">
        <p className="text-xs text-zinc-400">{sale.city}, {sale.state}</p>
        <Link
          to={`/sales/${sale.saleId}`}
          className="text-xs font-medium text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors duration-150"
        >
          View sale →
        </Link>
      </div>
    </article>
  );
}
