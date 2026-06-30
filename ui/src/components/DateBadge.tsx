import { formatDateBadge } from "../lib/format";

type DateBadgeProps = {
  startDate: string;
};

export function DateBadge({ startDate }: DateBadgeProps) {
  const label = formatDateBadge(startDate);

  const style =
    label === "Today"
      ? "bg-emerald-500 text-white"
      : label === "Tomorrow"
        ? "bg-blue-500 text-white"
        : label === "Sat" || label === "Sun"
          ? "bg-violet-500/10 text-violet-600 dark:text-violet-400"
          : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300";

  return (
    <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${style}`}>
      {label}
    </span>
  );
}
