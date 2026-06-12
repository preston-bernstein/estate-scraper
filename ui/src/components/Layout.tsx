import { NavLink, Outlet } from "react-router-dom";
import { useEffect, useState } from "react";
import { PlanPanel } from "./PlanPanel";
import { api } from "../lib/api";
import { formatLastScanned } from "../lib/format";

const tabs = [
  { to: "/plan", label: "Plan" },
  { to: "/", label: "Browse" },
  { to: "/hunts", label: "Hunts" },
];

export function Layout() {
  const [lastScannedAt, setLastScannedAt] = useState<string | null>(null);
  const [scanFailed, setScanFailed] = useState(false);
  const [userInitials, setUserInitials] = useState("?");

  useEffect(() => {
    api
      .getStatus()
      .then((status) => {
        setLastScannedAt(status.lastScannedAt);
        setScanFailed(status.scanFailed);
      })
      .catch(() => setScanFailed(true));

    api
      .getMe()
      .then((me) => setUserInitials(me.sub.slice(0, 2).toUpperCase()))
      .catch(() => setUserInitials("?"));
  }, []);

  return (
    <div className="min-h-screen bg-[#F2F2F7] text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <header className="sticky top-0 z-10 border-b border-black/5 bg-[#F2F2F7]/90 backdrop-blur dark:border-white/10 dark:bg-gray-950/90">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div>
            <p className="text-lg font-semibold">Estate Sale Scanner</p>
            <p
              className={`text-xs ${
                scanFailed ? "text-amber-600" : "text-gray-500"
              }`}
            >
              Last scanned: {formatLastScanned(lastScannedAt)}
            </p>
          </div>

          <nav className="hidden items-center gap-1 md:flex">
            {tabs.map((tab) => (
              <NavLink
                key={tab.to}
                to={tab.to}
                end={tab.to === "/"}
                className={({ isActive }) =>
                  `rounded-lg px-3 py-1.5 text-sm font-medium ${
                    isActive
                      ? "bg-[#007AFF]/10 text-[#007AFF]"
                      : "text-gray-600 hover:bg-white/60 dark:text-gray-300"
                  }`
                }
              >
                {tab.label}
              </NavLink>
            ))}
            <NavLink
              to="/history"
              className={({ isActive }) =>
                `rounded-lg px-3 py-1.5 text-sm font-medium ${
                  isActive
                    ? "bg-[#007AFF]/10 text-[#007AFF]"
                    : "text-gray-600 hover:bg-white/60 dark:text-gray-300"
                }`
              }
            >
              History
            </NavLink>
          </nav>

          <div className="hidden h-9 w-9 items-center justify-center rounded-full bg-gray-200 text-sm font-medium text-gray-600 md:flex dark:bg-gray-800 dark:text-gray-300">
            {userInitials}
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl gap-6 px-4 py-4 pb-24 md:pb-6">
        <aside className="hidden w-[280px] shrink-0 md:block">
          <div className="sticky top-20">
            <p className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-200">
              Plan
            </p>
            <PlanPanel compact />
          </div>
        </aside>

        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>

      <nav className="fixed inset-x-0 bottom-0 border-t border-black/5 bg-white/95 backdrop-blur md:hidden dark:border-white/10 dark:bg-gray-950/95">
        <div className="mx-auto flex max-w-lg">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              end={tab.to === "/"}
              className={({ isActive }) =>
                `flex-1 py-3 text-center text-xs font-medium ${
                  isActive ? "text-[#007AFF]" : "text-gray-500"
                }`
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
