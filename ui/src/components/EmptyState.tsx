import type { ReactNode } from "react";
import { Link } from "react-router-dom";

type EmptyStateProps = {
  icon: ReactNode;
  title: string;
  description: string;
  actionLabel?: string;
  actionTo?: string;
};

export function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  actionTo,
}: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center rounded-xl bg-white px-6 py-12 text-center shadow-sm">
      <div className="mb-4 text-4xl text-gray-400">{icon}</div>
      <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
      <p className="mt-2 max-w-sm text-sm text-gray-600">{description}</p>
      {actionLabel && actionTo ? (
        <Link
          to={actionTo}
          className="mt-6 rounded-full bg-[#007AFF] px-5 py-2 text-sm font-medium text-white"
        >
          {actionLabel}
        </Link>
      ) : null}
    </div>
  );
}
