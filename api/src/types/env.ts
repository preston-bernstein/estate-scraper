export const DEV_USER_SUB = "dev-user";

export type AppEnv = {
  Variables: {
    userSub: string;
  };
};

// Read at call time (not module load) so tests can override process.env and both the
// /me gate and the /scan/start gate see the same value from one place.
export function scanOwnerSub(): string {
  return process.env.SCAN_OWNER_SUB ?? "";
}

// Allowed browser origins for CORS. Same-origin prod (UI served by the API) needs
// none; dev serves the UI from Vite. Comma-separated override via CORS_ORIGIN.
export function corsOrigins(): string[] {
  return (process.env.CORS_ORIGIN ?? "http://localhost:5173")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}
