import { useEffect, useRef, type TouchEvent } from "react";
import type { Finding } from "../types";

type FindingLightboxProps = {
  findings: Finding[];
  index: number;
  onClose: () => void;
  onChangeIndex: (index: number) => void;
};

export function FindingLightbox({
  findings,
  index,
  onClose,
  onChangeIndex,
}: FindingLightboxProps) {
  const touchStartX = useRef<number | null>(null);
  const finding = findings[index];

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      } else if (event.key === "ArrowLeft" && index > 0) {
        onChangeIndex(index - 1);
      } else if (event.key === "ArrowRight" && index < findings.length - 1) {
        onChangeIndex(index + 1);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [index, findings.length, onChangeIndex, onClose]);

  if (!finding) {
    return null;
  }

  function handleTouchStart(event: TouchEvent) {
    touchStartX.current = event.touches[0]?.clientX ?? null;
  }

  function handleTouchEnd(event: TouchEvent) {
    if (touchStartX.current === null) {
      return;
    }

    const delta = (event.changedTouches[0]?.clientX ?? 0) - touchStartX.current;
    if (delta > 64 && index > 0) {
      onChangeIndex(index - 1);
    } else if (delta < -64 && index < findings.length - 1) {
      onChangeIndex(index + 1);
    }

    touchStartX.current = null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Finding image viewer"
    >
      <button
        type="button"
        className="absolute right-4 top-4 rounded-full bg-white/10 px-3 py-1 text-white"
        onClick={onClose}
      >
        Close
      </button>

      {index > 0 ? (
        <button
          type="button"
          className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 px-3 py-2 text-2xl text-white md:left-4"
          onClick={(event) => {
            event.stopPropagation();
            onChangeIndex(index - 1);
          }}
          aria-label="Previous image"
        >
          ‹
        </button>
      ) : null}

      {index < findings.length - 1 ? (
        <button
          type="button"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 px-3 py-2 text-2xl text-white md:right-4"
          onClick={(event) => {
            event.stopPropagation();
            onChangeIndex(index + 1);
          }}
          aria-label="Next image"
        >
          ›
        </button>
      ) : null}

      <div
        className="max-h-full max-w-4xl"
        onClick={(event) => event.stopPropagation()}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        <img
          src={finding.imageUrl}
          alt={finding.description}
          className="max-h-[70vh] w-full object-contain"
        />
        <p className="mt-3 text-center text-sm text-white/90">
          {finding.description}
        </p>
        <p className="mt-1 text-center text-xs text-white/60">
          {index + 1} / {findings.length}
        </p>
      </div>
    </div>
  );
}
