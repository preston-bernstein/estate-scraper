import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { userManager } from "../lib/auth";

export function CallbackPage() {
  const navigate = useNavigate();
  const handled = useRef(false);

  useEffect(() => {
    if (handled.current || !userManager) return;
    handled.current = true;

    userManager
      .signinRedirectCallback()
      .then(() => navigate("/", { replace: true }))
      .catch(() => navigate("/login", { replace: true }));
  }, [navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950">
      <p className="text-sm text-zinc-400">Signing in…</p>
    </div>
  );
}
