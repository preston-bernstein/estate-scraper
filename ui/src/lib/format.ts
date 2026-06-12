export function formatLastScanned(iso: string | null): string {
  if (!iso) {
    return "Never scanned";
  }

  const date = new Date(iso);
  return date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function formatDateBadge(startDate: string): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const start = new Date(`${startDate}T00:00:00`);
  start.setHours(0, 0, 0, 0);

  if (start.getTime() === today.getTime()) {
    return "Today";
  }

  const day = start.getDay();
  if (day === 6) {
    return "Sat";
  }
  if (day === 0) {
    return "Sun";
  }

  return start.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function cleanTitle(title: string): string {
  return title.replace(/^\(\d+\)\s*/, "").trim();
}

export function formatHuntMatchCounts(
  counts: { huntName: string; count: number }[],
): string {
  return counts.map(({ huntName, count }) => `${count} ${huntName}`).join(" · ");
}

export function formatDistance(miles: number): string {
  return `${miles.toFixed(1)} mi`;
}
