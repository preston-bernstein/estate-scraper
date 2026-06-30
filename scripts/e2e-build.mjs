// Builds the API and a STUB UI (no OIDC) for e2e, so the app loads as the stub user
// with no Authentik redirect. Moves ui/.env.production aside during the UI build so
// VITE_OIDC_* isn't baked in, then restores it.
import { execSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const run = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit" });

run("npm run build -w api");

const envProd = `${root}ui/.env.production`;
const stashed = `${envProd}.e2ebak`;
const hadEnv = existsSync(envProd);
if (hadEnv) renameSync(envProd, stashed);
try {
  run("npm run build -w ui");
} finally {
  if (hadEnv) renameSync(stashed, envProd);
}
console.log("[e2e] built api + stub ui");
