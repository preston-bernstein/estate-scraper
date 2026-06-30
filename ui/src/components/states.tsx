// Shared async-state UI: one consistent look for loading, error, and empty so every
// page communicates what's happening instead of showing a blank screen.

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="flex flex-col items-center justify-center py-16 text-sm text-zinc-500">
      <div className="mb-3 h-6 w-6 animate-spin rounded-full border-2 border-zinc-300 border-t-blue-500 dark:border-zinc-700 dark:border-t-blue-400" />
      {label}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div role="alert" className="flex flex-col items-center rounded-xl bg-white px-6 py-12 text-center shadow-sm dark:bg-zinc-900">
      <div className="mb-3 text-3xl">⚠️</div>
      <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">Something went wrong</h2>
      <p className="mt-1 max-w-sm text-sm text-zinc-600 dark:text-zinc-400">{message}</p>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-5 rounded-full bg-[#007AFF] px-5 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
        >
          Try again
        </button>
      )}
    </div>
  );
}
