import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { DateBadge } from "../components/DateBadge";
import { FindingLightbox } from "../components/FindingLightbox";
import { SaleMap } from "../components/SaleMap";
import { ResilientImage } from "../components/ResilientImage";
import { api } from "../lib/api";
import { cleanTitle, formatDistance } from "../lib/format";
import type { AnalyzedImage, Finding, SaleSummary } from "../types";

function ImageAuditPanel({ saleId }: { saleId: string }) {
  const [open, setOpen] = useState(false);
  const [imgs, setImgs] = useState<AnalyzedImage[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);

  async function load() {
    if (imgs !== null) { setOpen(true); return; }
    setLoading(true);
    try {
      const res = await api.getSaleImages(saleId);
      setImgs(res.images);
      setOpen(true);
    } finally {
      setLoading(false);
    }
  }

  const findings = imgs?.filter((i) => i.hasFindings).length ?? 0;
  const total = imgs?.length ?? 0;

  return (
    <section className="rounded-xl bg-white p-4 shadow-sm space-y-3">
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : void load())}
        className="flex w-full items-center justify-between text-sm font-medium text-gray-700"
      >
        <span>
          Image Audit
          {imgs !== null && (
            <span className="ml-2 font-normal text-gray-400">
              {findings} hits / {total} analyzed
            </span>
          )}
        </span>
        <span className="text-gray-400">{open ? "▲" : "▼"}</span>
      </button>

      {loading && <p className="text-xs text-gray-400">Loading…</p>}

      {open && imgs !== null && (
        <div className="space-y-2">
          <p className="text-xs text-gray-400">
            Green border = the vision model found something. Gray = nothing / gated. Click for raw response.
          </p>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
            {imgs.map((img) => {
              const thumbSrc = img.thumbnailPath ? `/thumbs/${img.id}` : img.imageUrl;
              const isExpanded = expanded === img.id;
              return (
                <div key={img.id} className="space-y-1">
                  <button
                    type="button"
                    onClick={() => setExpanded(isExpanded ? null : img.id)}
                    className={`block w-full overflow-hidden rounded-lg border-2 ${
                      img.hasFindings
                        ? "border-green-400"
                        : "border-transparent"
                    }`}
                  >
                    <img
                      src={thumbSrc}
                      alt=""
                      className="aspect-square w-full object-cover"
                      loading="lazy"
                      onError={(e) => { (e.target as HTMLImageElement).src = img.imageUrl; }}
                    />
                  </button>
                  {isExpanded && (
                    <pre className="col-span-full whitespace-pre-wrap break-words rounded bg-zinc-50 p-2 text-xs text-zinc-700 leading-relaxed border border-zinc-200">
                      {img.visionResponse ?? "(gated — no response)"}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

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
      // Default to showing every finding when none match the user's Hunts (or there
      // are no Hunts at all). Otherwise the "matched" filter hides all findings and
      // the sale looks empty even though it has findings — the whole page reads as
      // broken. When there ARE matches, keep the focused matched-only default.
      setShowAll(result.matchedFindingCount === 0);
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
                className="group cursor-pointer overflow-hidden rounded-xl bg-white shadow-sm hover:shadow-md transition-shadow duration-200 dark:bg-zinc-900"
              >
                <button
                  type="button"
                  className="block w-full text-left active:scale-[0.99] transition-transform duration-100"
                  onClick={() => setLightboxIndex(index)}
                >
                  <div className="overflow-hidden">
                    <ResilientImage
                      srcs={[finding.thumbUrl, finding.imageUrl]}
                      alt={finding.description}
                      className="aspect-square w-full object-cover group-hover:scale-105 transition-transform duration-300"
                    />
                  </div>
                  <figcaption className="p-3 text-sm text-gray-700 dark:text-zinc-300">
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

      <ImageAuditPanel saleId={sale.saleId} />

      <section className="rounded-xl bg-white p-4 shadow-sm">
        <OutcomePanel saleId={sale.saleId} />
      </section>
    </div>
  );
}
