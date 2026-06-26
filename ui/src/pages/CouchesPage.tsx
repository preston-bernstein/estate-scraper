import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import { cleanTitle, formatDateBadge, formatDistance } from "../lib/format";
import type { FindingWithSale } from "../types";

const COUCH_KEYWORDS = ["couch", "sofa", "sectional", "loveseat"];

export function CouchesPage() {
  const [findings, setFindings] = useState<FindingWithSale[]>([]);
  const [loading, setLoading] = useState(true);
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  useEffect(() => {
    api
      .searchFindings(COUCH_KEYWORDS)
      .then((data) => setFindings(data.findings))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex h-48 items-center justify-center text-gray-400">
        Loading…
      </div>
    );
  }

  if (findings.length === 0) {
    return (
      <div className="flex h-48 flex-col items-center justify-center gap-2 text-gray-400">
        <p className="text-lg font-medium">No sofas found</p>
        <p className="text-sm">Run a scan to populate findings.</p>
      </div>
    );
  }

  return (
    <div>
      <p className="mb-4 text-sm text-gray-500">{findings.length} sofas &amp; couches across all scans</p>

      <div className="columns-2 gap-3 sm:columns-3 lg:columns-4">
        {findings.map((finding, i) => (
          <div
            key={finding.id}
            className="mb-3 break-inside-avoid overflow-hidden rounded-xl bg-white shadow-sm dark:bg-gray-900"
          >
            <button
              type="button"
              className="w-full"
              onClick={() => setLightboxIndex(i)}
            >
              <img
                src={finding.imageUrl}
                alt={finding.description}
                className="w-full object-cover"
                loading="lazy"
              />
            </button>
            <div className="p-2">
              <p className="text-xs text-gray-700 dark:text-gray-300">
                {finding.description}
              </p>
              <Link
                to={`/sales/${finding.saleId}`}
                className="mt-1 block truncate text-[11px] text-[#007AFF] hover:underline"
              >
                {cleanTitle(finding.saleTitle)}
              </Link>
              <p className="text-[11px] text-gray-400">
                {formatDateBadge(finding.saleStartDate)} · {formatDistance(finding.distanceMiles)}
              </p>
            </div>
          </div>
        ))}
      </div>

      {lightboxIndex !== null && (
        <CouchLightbox
          findings={findings}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onChangeIndex={setLightboxIndex}
        />
      )}
    </div>
  );
}

function CouchLightbox({
  findings,
  index,
  onClose,
  onChangeIndex,
}: {
  findings: FindingWithSale[];
  index: number;
  onClose: () => void;
  onChangeIndex: (i: number) => void;
}) {
  const finding = findings[index];

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowLeft" && index > 0) onChangeIndex(index - 1);
      if (e.key === "ArrowRight" && index < findings.length - 1) onChangeIndex(index + 1);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [index, findings.length, onClose, onChangeIndex]);

  if (!finding) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <button
        type="button"
        className="absolute right-4 top-4 rounded-full bg-white/10 px-3 py-1 text-white"
        onClick={onClose}
      >
        Close
      </button>

      {index > 0 && (
        <button
          type="button"
          className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 px-3 py-2 text-2xl text-white md:left-4"
          onClick={(e) => { e.stopPropagation(); onChangeIndex(index - 1); }}
          aria-label="Previous"
        >
          ‹
        </button>
      )}

      {index < findings.length - 1 && (
        <button
          type="button"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 px-3 py-2 text-2xl text-white md:right-4"
          onClick={(e) => { e.stopPropagation(); onChangeIndex(index + 1); }}
          aria-label="Next"
        >
          ›
        </button>
      )}

      <div
        className="max-h-full max-w-4xl"
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={finding.imageUrl}
          alt={finding.description}
          className="max-h-[70vh] w-full object-contain"
        />
        <p className="mt-3 text-center text-sm text-white/90">{finding.description}</p>
        <Link
          to={`/sales/${finding.saleId}`}
          onClick={onClose}
          className="mt-1 block text-center text-xs text-[#007AFF] hover:underline"
        >
          {cleanTitle(finding.saleTitle)} · {formatDistance(finding.distanceMiles)}
        </Link>
        <p className="mt-1 text-center text-xs text-white/50">
          {index + 1} / {findings.length}
        </p>
      </div>
    </div>
  );
}
