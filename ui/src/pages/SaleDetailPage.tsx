import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { DateBadge } from "../components/DateBadge";
import { FindingLightbox } from "../components/FindingLightbox";
import { SaleMap } from "../components/SaleMap";
import { api } from "../lib/api";
import { cleanTitle, formatDistance } from "../lib/format";
import type { Finding, SaleSummary } from "../types";

export function SaleDetailPage() {
  const { id = "" } = useParams();
  const [sale, setSale] = useState<SaleSummary | null>(null);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [matchedCount, setMatchedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const result = await api.getSale(id);
      setSale(result.sale);
      setFindings(result.findings);
      setMatchedCount(result.matchedFindingCount);
      setTotalCount(result.totalFindingCount);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sale");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return <p className="text-sm text-gray-500">Loading sale…</p>;
  }

  if (error || !sale) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-red-600">{error ?? "Sale not found"}</p>
        <Link to="/" className="text-sm text-[#007AFF]">
          Back to browse
        </Link>
      </div>
    );
  }

  const visibleFindings = showAll
    ? findings
    : findings.filter((finding) => finding.matched);

  function toggleShowAll() {
    setLightboxIndex(null);
    setShowAll((current) => !current);
  }

  return (
    <div className="space-y-6">
      <Link to="/" className="text-sm text-[#007AFF]">
        ← Back
      </Link>

      <section className="rounded-xl bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">{cleanTitle(sale.title)}</h1>
          <DateBadge startDate={sale.startDate} />
        </div>
        <p className="mt-2 text-sm text-gray-600">
          {sale.address}, {sale.city}, {sale.state} {sale.zip}
        </p>
        <p className="mt-1 text-sm text-gray-500">
          {sale.startDate} – {sale.endDate} · {formatDistance(sale.distanceMiles)}
        </p>
        <a
          href={sale.url}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-block text-sm text-[#007AFF]"
        >
          View listing
        </a>
      </section>

      <SaleMap
        lat={sale.lat}
        lon={sale.lon}
        label={cleanTitle(sale.title)}
      />

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-medium">Findings</h2>
          <button
            type="button"
            onClick={toggleShowAll}
            className="text-sm text-[#007AFF]"
          >
            {showAll
              ? `Showing ${totalCount} total · show matched`
              : `Showing ${matchedCount} matched · show all ${totalCount}`}
          </button>
        </div>

        {visibleFindings.length === 0 ? (
          <p className="text-sm text-gray-500">No findings to show.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            {visibleFindings.map((finding, index) => (
              <figure
                key={finding.id}
                className="cursor-pointer overflow-hidden rounded-xl bg-white shadow-sm"
              >
                <button
                  type="button"
                  className="block w-full text-left"
                  onClick={() => setLightboxIndex(index)}
                >
                  <img
                    src={finding.imageUrl}
                    alt={finding.description}
                    className="aspect-square w-full object-cover"
                  />
                  <figcaption className="p-3 text-sm text-gray-700">
                    {finding.description}
                  </figcaption>
                </button>
              </figure>
            ))}
          </div>
        )}
      </section>

      {lightboxIndex !== null ? (
        <FindingLightbox
          findings={visibleFindings}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onChangeIndex={setLightboxIndex}
        />
      ) : null}
    </div>
  );
}
