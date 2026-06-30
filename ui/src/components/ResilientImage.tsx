import { useState } from "react";

// Tries each source in order, advancing on load error. Used so a dead CDN url (the
// source 404s days after a sale ends) falls back to our durable saved thumbnail —
// or, when nothing loads, a neutral placeholder instead of a broken-image icon.
export function ResilientImage({
  srcs,
  alt,
  className,
}: {
  srcs: (string | null | undefined)[];
  alt: string;
  className?: string;
}) {
  const candidates = srcs.filter((s): s is string => Boolean(s));
  const [idx, setIdx] = useState(0);

  if (candidates.length === 0 || idx >= candidates.length) {
    return (
      <div
        role="img"
        aria-label={alt}
        className={`flex items-center justify-center bg-zinc-100 text-zinc-300 dark:bg-zinc-800 dark:text-zinc-600 ${className ?? ""}`}
      >
        <span className="text-xs">No image</span>
      </div>
    );
  }

  return (
    <img
      src={candidates[idx]}
      alt={alt}
      loading="lazy"
      className={className}
      onError={() => setIdx((i) => i + 1)}
    />
  );
}
