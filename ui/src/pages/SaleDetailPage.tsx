import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { DateBadge } from "../components/DateBadge";
import { FindingLightbox } from "../components/FindingLightbox";
import { SaleMap } from "../components/SaleMap";
import { ResilientImage } from "../components/ResilientImage";
import { api } from "../lib/api";
import { cleanTitle, formatDistance } from "../lib/format";
import type { Finding, SaleSummary } from "../types";

type Outcome = "good" | "meh" | "waste";

const OUTCOME_LABELS: Record<Outcome, string> = {
  good: "Good find",
  meh: "Meh",
  waste: "Waste of time",
};

function OutcomePanel({ saleId }: { saleId: string }) {
  const [saved, setSaved] = useState<Outcome | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getOutcome(saleId)
      .then((res) => {
        if (res.outcome) setSaved(res.outcome.outcome);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [saleId]);

  async function submit(outcome: Outcome) {
    setSaving(true);
    try {
      await api.recordOutcome(saleId, true, outcome);
      setSaved(outcome);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return null;

  if (saved) {
    return (
      <p className="text-sm text-gray-500">
        Logged: <span className="font-medium text-gray-700">{OUTCOME_LABELS[saved]}</span>
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-gray-700">How was this sale?</p>
      <div className="flex gap-2">
        {(["good", "meh", "waste"] as Outcome[]).map((o) => (
          <button
            key={o}
            type="button"
            disabled={saving}
            onClick={() => void submit(o)}
            className="rounded-full border border-zinc-200 px-3 py-1 text-sm text-gray-700 hover:bg-zinc-100 disabled:opacity-50"
          >
            {OUTCOME_LABELS[o]}
          </button>
        ))}
      </div>
    </div>
  );
}

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
                  <ResilientImage
                    srcs={[finding.thumbUrl, finding.imageUrl]}
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

      <section className="rounded-xl bg-white p-4 shadow-sm">
        <OutcomePanel saleId={sale.saleId} />
      </section>
    </div>
  );
}
