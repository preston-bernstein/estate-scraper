import { useCallback, useEffect, useRef, useState, type TouchEvent } from "react";
import { Link } from "react-router-dom";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { EmptyState } from "./EmptyState";
import { DateBadge } from "./DateBadge";
import { api } from "../lib/api";
import { cleanTitle, formatDistance } from "../lib/format";
import type { SaleSummary } from "../types";

type PlanPanelProps = {
  compact?: boolean;
};

type SortablePlanItemProps = {
  sale: SaleSummary;
  index: number;
  onRemove: (saleId: string) => void;
};

function SortablePlanItem({ sale, index, onRemove }: SortablePlanItemProps) {
  const touchStartX = useRef<number | null>(null);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sale.saleId });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  function handleTouchStart(event: TouchEvent) {
    touchStartX.current = event.touches[0]?.clientX ?? null;
  }

  function handleTouchMove(event: TouchEvent) {
    if (touchStartX.current === null) {
      return;
    }

    const delta = event.touches[0]!.clientX - touchStartX.current;
    if (delta < 0) {
      setSwipeOffset(Math.max(delta, -96));
    }
  }

  function handleTouchEnd() {
    if (swipeOffset < -64) {
      onRemove(sale.saleId);
    }

    touchStartX.current = null;
    setSwipeOffset(0);
  }

  return (
    <li
      ref={setNodeRef}
      style={{
        ...style,
        transform: [
          CSS.Transform.toString(transform),
          swipeOffset ? `translateX(${swipeOffset}px)` : "",
        ]
          .filter(Boolean)
          .join(" "),
      }}
      className={`group relative flex items-center gap-3 rounded-xl bg-white p-4 shadow-sm hover:shadow-md transition-shadow duration-200 dark:bg-zinc-900 ${
        isDragging ? "z-10 opacity-90 shadow-lg" : ""
      }`}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <button
        type="button"
        className="cursor-grab touch-none text-gray-400 active:cursor-grabbing"
        aria-label="Drag to reorder"
        {...attributes}
        {...listeners}
      >
        ⠿
      </button>

      <span className="w-5 shrink-0 text-sm font-medium text-gray-400">
        {index + 1}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Link
            to={`/sales/${sale.saleId}`}
            className="truncate font-medium text-gray-900 hover:text-[#007AFF] dark:text-gray-100"
          >
            {cleanTitle(sale.title)}
          </Link>
          <DateBadge startDate={sale.startDate} />
        </div>
        <p className="text-sm text-gray-500">
          {formatDistance(sale.distanceMiles)}
        </p>
      </div>

      <button
        type="button"
        onClick={() => onRemove(sale.saleId)}
        className="rounded-full px-3 py-1 text-sm text-gray-500 opacity-100 transition-all duration-150 hover:bg-red-50 hover:text-red-500 active:scale-95 dark:hover:bg-red-950/30 md:opacity-0 md:group-hover:opacity-100"
        aria-label="Remove from plan"
      >
        ×
      </button>
    </li>
  );
}

export function PlanPanel({ compact = false }: PlanPanelProps) {
  const [items, setItems] = useState<SaleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await api.getPlan();
      setItems(result.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load plan");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleRemove(saleId: string) {
    await api.removeFromPlan(saleId);
    setItems((current) => current.filter((item) => item.saleId !== saleId));
  }

  async function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    const oldIndex = items.findIndex((item) => item.saleId === active.id);
    const newIndex = items.findIndex((item) => item.saleId === over.id);
    const reordered = arrayMove(items, oldIndex, newIndex);

    setItems(reordered);
    await api.reorderPlan(reordered.map((item) => item.saleId));
  }

  if (loading) {
    return <p className="text-sm text-gray-500">Loading plan…</p>;
  }

  if (error) {
    return <p className="text-sm text-red-600">{error}</p>;
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon="🗺️"
        title="Add sales to build your plan"
        description={
          compact
            ? "Tap + Plan on Browse cards."
            : "Browse Hunt-matched sales and tap + Plan on the ones you want to visit."
        }
        actionLabel={compact ? undefined : "Browse sales"}
        actionTo={compact ? undefined : "/"}
      />
    );
  }

  return (
    <div className="space-y-3">
      {!compact ? <h1 className="text-xl font-semibold">Plan</h1> : null}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={(event) => void handleDragEnd(event)}
      >
        <SortableContext
          items={items.map((item) => item.saleId)}
          strategy={verticalListSortingStrategy}
        >
          <ol className="space-y-3">
            {items.map((sale, index) => (
              <SortablePlanItem
                key={sale.saleId}
                sale={sale}
                index={index}
                onRemove={(saleId) => void handleRemove(saleId)}
              />
            ))}
          </ol>
        </SortableContext>
      </DndContext>
    </div>
  );
}
