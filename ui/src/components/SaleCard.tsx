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
    <article className="overflow-hidden rounded-xl bg-white shadow-sm">
      <Link to={`/sales/${sale.saleId}`} className="block p-4">
        <div className="flex gap-4">
          <ResilientImage
            srcs={[sale.thumbUrl, sale.thumbnailUrl]}
            alt={sale.thumbnailDescription ?? cleanTitle(sale.title)}
            className="h-20 w-20 shrink-0 overflow-hidden rounded-lg bg-gray-100 object-cover"
          />

          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-2">
              <h3 className="line-clamp-2 font-medium text-gray-900">
                {cleanTitle(sale.title)}
              </h3>
              <DateBadge startDate={sale.startDate} />
            </div>

            <p className="mt-1 text-sm text-gray-500">
              {formatDistance(sale.distanceMiles)}
            </p>

            {sale.huntMatchCounts.length > 0 ? (
              <p className="mt-2 text-sm text-gray-700">
                {formatHuntMatchCounts(sale.huntMatchCounts)}
              </p>
            ) : null}
          </div>
        </div>
      </Link>

      {showPlanButton && onAddToPlan ? (
        <div className="border-t border-gray-100 px-4 py-3">
          <button
            type="button"
            disabled={inPlan}
            onClick={onAddToPlan}
            className="rounded-full bg-[#007AFF] px-4 py-1.5 text-sm font-medium text-white disabled:cursor-default disabled:bg-gray-300"
          >
            {inPlan ? "In Plan" : "+ Plan"}
          </button>
        </div>
      ) : null}
    </article>
  );
}
