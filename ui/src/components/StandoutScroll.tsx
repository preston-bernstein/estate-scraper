import { Link } from "react-router-dom";
import type { Standout } from "../types";
import { cn } from "../lib/utils";

const TAG_COLORS: Record<Standout["tag"], string> = {
  electronics: "bg-blue-500/10 text-blue-400 ring-blue-500/20",
  kitsch: "bg-pink-500/10 text-pink-400 ring-pink-500/20",
  collectible: "bg-amber-500/10 text-amber-400 ring-amber-500/20",
  furniture: "bg-zinc-500/10 text-zinc-400 ring-zinc-500/20",
};

const TAG_LABELS: Record<Standout["tag"], string> = {
  electronics: "Electronics",
  kitsch: "Kitsch",
  collectible: "Collectible",
  furniture: "Furniture",
};

type Props = { standouts: Standout[] };

export function StandoutScroll({ standouts }: Props) {
  if (standouts.length === 0) return null;

  return (
    <section>
      <h2 className="text-sm font-semibold text-zinc-500 dark:text-zinc-400 uppercase tracking-wider mb-3">
        Standouts this week
      </h2>
      <div className="flex gap-3 overflow-x-auto pb-2 no-scrollbar">
        {standouts.map((s) => (
          <Link
            key={s.id}
            to={`/sales/${s.saleId}`}
            className="flex-none w-44 group"
          >
            <div className="aspect-square rounded-xl overflow-hidden bg-zinc-100 dark:bg-zinc-800 mb-2 relative">
              {s.imageUrl ? (
                <img
                  src={s.imageUrl}
                  alt=""
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  loading="lazy"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-zinc-400 text-2xl">
                  ?
                </div>
              )}
              <span
                className={cn(
                  "absolute top-1.5 left-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded-full ring-1",
                  TAG_COLORS[s.tag],
                )}
              >
                {TAG_LABELS[s.tag]}
              </span>
            </div>
            <p className="text-xs text-zinc-700 dark:text-zinc-300 line-clamp-2 leading-tight">
              {s.description}
            </p>
            <p className="text-[10px] text-zinc-400 mt-0.5">{s.distanceMiles.toFixed(1)}mi</p>
          </Link>
        ))}
      </div>
    </section>
  );
}
