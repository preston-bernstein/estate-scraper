import { Link } from "react-router-dom";
import type { SaleSummary } from "../types";
import {
  cleanTitle,
  formatDistance,
  formatHuntMatchCounts,
} from "../lib/format";
import { DateBadge } from "./DateBadge";
import { ResilientImage } from "./ResilientImage";

type SaleCardProps = {
  sale: SaleSummary;
  inPlan?: boolean;
  onAddToPlan?: () => void;
  showPlanButton?: boolean;
};

export function SaleCard({
  sale,
  inPlan = false,
  onAddToPlan,
  showPlanButton = true,
}: SaleCardProps) {
  return (
    <article className="group overflow-hidden rounded-xl bg-white shadow-sm hover:shadow-md transition-shadow duration-200 dark:bg-zinc-900">
      <Link
        to={`/sales/${sale.saleId}`}
        className="block p-4 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors duration-150"
      >
        <div className="flex gap-4">
          <div className="h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-gray-100">
            <ResilientImage
              srcs={[sale.thumbUrl, sale.thumbnailUrl]}
              alt={sale.thumbnailDescription ?? cleanTitle(sale.title)}
              className="h-full w-full object-cover group-hover:scale-105 transition-transform duration-300"
            />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <h3 className="line-clamp-2 font-medium text-gray-900 dark:text-zinc-100">
                {cleanTitle(sale.title)}
              </h3>
              <DateBadge startDate={sale.startDate} />
            </div>

            <p className="mt-1 text-sm text-gray-500 dark:text-zinc-400">
              {formatDistance(sale.distanceMiles)}
            </p>

            {sale.huntMatchCounts.length > 0 ? (
              <p className="mt-2 text-sm text-gray-700 dark:text-zinc-300">
                {formatHuntMatchCounts(sale.huntMatchCounts)}
              </p>
            ) : null}
          </div>
        </div>
      </Link>

      {showPlanButton && onAddToPlan ? (
        <div className="border-t border-gray-100 dark:border-zinc-800 px-4 py-3">
          <button
            type="button"
            disabled={inPlan}
            onClick={onAddToPlan}
            className="rounded-full bg-blue-500 px-4 py-1.5 text-sm font-medium text-white transition-all duration-100 hover:bg-blue-600 active:scale-95 disabled:cursor-default disabled:bg-gray-300 dark:disabled:bg-zinc-600"
          >
            {inPlan ? "In Plan" : "+ Plan"}
          </button>
        </div>
      ) : null}
    </article>
  );
}
