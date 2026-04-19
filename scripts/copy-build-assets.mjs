import path from "node:path";
import { readdir, mkdir, copyFile, stat } from "node:fs/promises";

async function main() {
  const repoRoot = path.resolve(".");
  const srcRoot = path.join(repoRoot, "src");
  const distRoot = path.join(repoRoot, "dist");

  const srcStat = await stat(srcRoot).catch(() => null);
  if (!srcStat || !srcStat.isDirectory()) {
    throw new Error(`Missing src/ directory at ${srcRoot}`);
  }
  const distStat = await stat(distRoot).catch(() => null);
  if (!distStat || !distStat.isDirectory()) {
    throw new Error(`Missing dist/ directory at ${distRoot} (did you run tsc first?)`);
  }

  const files = await walk(srcRoot);
  const assets = files.filter((f) => f.endsWith(".json"));
  for (const srcPath of assets) {
    const rel = path.relative(srcRoot, srcPath);
    const outPath = path.join(distRoot, rel);
    await mkdir(path.dirname(outPath), { recursive: true });
    await copyFile(srcPath, outPath);
  }

  if (assets.length > 0) {
    console.log(`Copied ${assets.length} JSON asset(s) into dist/`);
  }
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});

