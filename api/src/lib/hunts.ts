export type HuntMatchCount = {
  huntName: string;
  count: number;
};

export function findingMatchesKeywords(
  description: string,
  keywords: string[],
): boolean {
  const haystack = description.toLowerCase();
  return keywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
}

export function countHuntMatches(
  description: string,
  hunts: { name: string; keywords: string[] }[],
): HuntMatchCount[] {
  return hunts
    .map((hunt) => ({
      huntName: hunt.name,
      count: hunt.keywords.some((keyword) =>
        findingMatchesKeywords(description, [keyword]),
      )
        ? 1
        : 0,
    }))
    .filter((entry) => entry.count > 0);
}

export function aggregateHuntMatchCounts(
  descriptions: string[],
  hunts: { name: string; keywords: string[] }[],
): HuntMatchCount[] {
  const totals = new Map<string, number>();

  for (const description of descriptions) {
    for (const hunt of hunts) {
      const matches = hunt.keywords.filter((keyword) =>
        findingMatchesKeywords(description, [keyword]),
      ).length;
      if (matches > 0) {
        totals.set(hunt.name, (totals.get(hunt.name) ?? 0) + 1);
      }
    }
  }

  return [...totals.entries()].map(([huntName, count]) => ({ huntName, count }));
}

export function saleMatchesHunts(
  descriptions: string[],
  hunts: { name: string; keywords: string[] }[],
): boolean {
  if (hunts.length === 0) {
    return false;
  }

  return descriptions.some((description) =>
    hunts.some((hunt) => findingMatchesKeywords(description, hunt.keywords)),
  );
}

export function filterMatchedDescriptions(
  descriptions: string[],
  hunts: { name: string; keywords: string[] }[],
): string[] {
  return descriptions.filter((description) =>
    hunts.some((hunt) => findingMatchesKeywords(description, hunt.keywords)),
  );
}
