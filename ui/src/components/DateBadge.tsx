import { formatDateBadge } from "../lib/format";

type DateBadgeProps = {
  startDate: string;
};

export function DateBadge({ startDate }: DateBadgeProps) {
  const label = formatDateBadge(startDate);
  const isToday = label === "Today";

  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
        isToday
          ? "bg-[#007AFF] text-white"
          : "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200"
      }`}
    >
      {label}
    </span>
  );
}
