import { NavLink, Outlet } from "react-router-dom";
import { use, Suspense } from "react";
import { LogOut } from "lucide-react";
import { ChatPanel } from "./ChatPanel";
import { ErrorBoundary } from "./ErrorBoundary";
import { api } from "../lib/api";
import { cached } from "../lib/cache";
import { useAuth } from "../context/AuthContext";
import { formatLastScanned } from "../lib/format";

const tabs = [
  { to: "/", label: "Discover", end: true },
  { to: "/browse", label: "Browse", end: false },
  { to: "/plan", label: "Plan", end: false },
  { to: "/hunts", label: "Hunts", end: false },
  { to: "/history", label: "History", end: false },
];

function ScanStatus() {
  const status = use(cached("status", api.getStatus));
  return (
    <p className={`text-xs ${status.scanFailed ? "text-amber-600" : "text-zinc-500"}`}>
      {status.scanRunning ? "Scanning…" : `Last scanned: ${formatLastScanned(status.lastScannedAt)}`}
    </p>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const initials = user?.profile?.name
    ? user.profile.name.slice(0, 2).toUpperCase()
    : user?.profile?.email
      ? user.profile.email.slice(0, 2).toUpperCase()
      : "ME";

  return (
    <div className="hidden items-center gap-2 md:flex">
      <div className="h-8 w-8 items-center justify-center rounded-full bg-zinc-200 text-xs font-semibold text-zinc-600 flex dark:bg-zinc-800 dark:text-zinc-300">
        {initials}
      </div>
      <button
        onClick={() => logout()}
        title="Sign out"
        className="rounded-lg p-1.5 text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
      >
        <LogOut size={15} />
      </button>
    </div>
  );
}

export function Layout() {
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="sticky top-0 z-20 border-b border-black/5 bg-zinc-50/90 backdrop-blur dark:border-white/10 dark:bg-zinc-950/90">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <div>
            <p className="text-base font-semibold tracking-tight">Estate Sales</p>
            {/* Status is non-critical — if it fails, stay quiet rather than crash the shell. */}
            <ErrorBoundary fallback={() => <span className="text-xs text-zinc-400">Status unavailable</span>}>
              <Suspense fallback={<p className="text-xs text-zinc-400">Loading…</p>}>
                <ScanStatus />
              </Suspense>
            </ErrorBoundary>
          </div>

          <nav className="hidden items-center gap-1 md:flex">
            {tabs.map((tab) => (
              <NavLink
                key={tab.to}
                to={tab.to}
                end={tab.end}
                className={({ isActive }) =>
                  `rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900"
                      : "text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200"
                  }`
                }
              >
                {tab.label}
              </NavLink>
            ))}
          </nav>

          <UserMenu />
        </div>
      </header>

      <main className="mx-auto max-w-3xl pb-24 md:pb-6">
        {/* Page-level boundary: a failed page shows a retry UI; the nav/shell stays. */}
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </main>

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 border-t border-black/5 bg-white/95 backdrop-blur md:hidden dark:border-white/10 dark:bg-zinc-950/95 z-20">
        <div className="mx-auto flex max-w-lg">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.end}
              className={({ isActive }) =>
                `flex-1 py-3 text-center text-xs font-medium transition-colors ${
                  isActive ? "text-zinc-900 dark:text-zinc-50" : "text-zinc-400"
                }`
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </div>
      </nav>

      <ChatPanel />
    </div>
  );
}
