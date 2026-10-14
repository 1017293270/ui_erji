// Bundles the api and the worker, dependencies included, into dist/: the image then needs
// no node_modules. Runs inside the Docker build on the server, and locally for smoke tests.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { build } from "esbuild";

const git = (...args) => {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};
// The Docker build has no .git; update.sh passes the version in instead.
const version =
  process.env.ECHOMIND_VERSION ||
  (() => {
    const commit = git("rev-parse", "--short", "HEAD") || "nogit";
    const dirty = git("status", "--porcelain", "--", ".") ? "-dirty" : "";
    const stamp = new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" }).slice(0, 16).replace(" ", "T");
    return `${stamp}+${commit}${dirty}`;
  })();

rmSync("dist", { recursive: true, force: true });
await build({
  entryPoints: ["src/main.ts", "src/worker.ts"],
  outdir: "dist",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  sourcemap: true,
  legalComments: "none",
  // CommonJS dependencies inside an ESM bundle still call require().
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  define: { __VERSION__: JSON.stringify(version) },
  logLevel: "warning",
});
console.log(`dist/ 已生成，版本 ${version}`);
