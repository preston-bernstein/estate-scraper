import { Component, type ReactNode } from "react";
import { invalidateAll } from "../lib/cache";
import { ErrorState } from "./states";

// Translates thrown errors into a friendly, actionable message. Auth failures get a
// distinct nudge; everything else is treated as a transient load failure.
export function friendlyMessage(error: unknown): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (msg === "Unauthorized") return "Your session expired. Please sign in again.";
  return "We couldn't load this. Check your connection and try again.";
}

type Props = {
  children: ReactNode;
  // Custom fallback (e.g. a minimal inline message for the header). Receives a reset
  // fn that clears caches and re-renders the subtree.
  fallback?: (reset: () => void, error: unknown) => ReactNode;
};
type State = { error: unknown };

// Catches render/data errors (including promises thrown by React 19 `use()` under
// Suspense) so a failed fetch shows a retry UI instead of a white screen.
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  componentDidCatch(error: unknown) {
    console.error("UI error boundary caught:", error);
  }

  reset = () => {
    invalidateAll(); // drop cached rejected promises so the retry actually refetches
    this.setState({ error: null });
  };

  render() {
    if (this.state.error !== null) {
      if (this.props.fallback) return this.props.fallback(this.reset, this.state.error);
      return <ErrorState message={friendlyMessage(this.state.error)} onRetry={this.reset} />;
    }
    return this.props.children;
  }
}
