import type { VisionEvent } from "../vision/index.js";

// One row of the frozen reference-pass dump (ADR 0010) — money-no-object ground
// truth that recall@K (and, since runpod-vision-cutover, backend agreement rate
// in api/eval/calibrate-runpod.ts) is measured against. Written to disk as a JSON
// array by scan/index.ts's `--reference <path>` flag.
export type ReferenceRecord = {
  saleId: string;
  saleTitle: string;
  saleUrl: string;
  imageUrl: string;
  positionIndex: number;
  total: number;
  response: string;
  hasFindings: boolean;
  error: string;
  durationS: number;
  backend: string;
};

// Maps a reference-mode `image_result` VisionEvent into the flat ReferenceRecord
// row scan/index.ts accumulates. Pulled out of scan/index.ts (rather than left
// inline in its main() loop) because scan/index.ts is a self-executing CLI
// entrypoint — main() runs as an import side effect — so nothing defined there is
// unit-testable without triggering a real scan. This is pure data reshaping (no
// branching): saleTitle/saleUrl come from the enclosing loop's current-sale state
// (not carried on the event itself), everything else copies straight off `event`.
export function toReferenceRecord(
  event: Extract<VisionEvent, { type: "image_result" }>,
  saleTitle: string,
  saleUrl: string,
): ReferenceRecord {
  return {
    saleId: event.saleId,
    saleTitle,
    saleUrl,
    imageUrl: event.imageUrl,
    positionIndex: event.positionIndex,
    total: event.total,
    response: event.response,
    hasFindings: event.hasFindings,
    error: event.error,
    durationS: event.durationS,
    backend: event.backend,
  };
}
