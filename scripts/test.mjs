import { build } from "esbuild";
import { spawnSync } from "node:child_process";
await build({
  entryPoints: ["tests/mvp.test.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: ".test-build/mvp.test.cjs",
  external: ["jsdom", "typescript", "node:*"],
});
const result = spawnSync(
  process.execPath,
  ["--test", ...process.argv.slice(2), ".test-build/mvp.test.cjs"],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
