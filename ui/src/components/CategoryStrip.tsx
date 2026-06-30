import { cn } from "../lib/utils";

export type Category = "all" | "electronics" | "kitsch" | "collectible" | "furniture";

const LABELS: Record<Category, string> = {
  all: "All",
  electronics: "Electronics",
  kitsch: "Kitsch & Camp",
  collectible: "Collectibles",
  furniture: "Furniture",
};

type Props = {
  active: Category;
  counts: Record<Category, number>;
  onChange: (c: Category) => void;
};

export function CategoryStrip({ active, counts, onChange }: Props) {
  const cats = Object.keys(LABELS) as Category[];
  return (
    <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar">
      {cats.map((cat) => (
        <button
          key={cat}
          onClick={() => onChange(cat)}
          className={cn(
            "flex-none px-3.5 py-1.5 rounded-full text-sm font-medium transition-all duration-150 ease-out whitespace-nowrap active:scale-95",
            active === cat
              ? "bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900 scale-[1.02] shadow-sm"
              : "border border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-800/60",
          )}
        >
          {LABELS[cat]}
          {cat !== "all" && counts[cat] > 0 && (
            <span className="ml-1.5 text-xs opacity-60">{counts[cat]}</span>
          )}
        </button>
      ))}
    </div>
  );
}
