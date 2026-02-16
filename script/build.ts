import { build as esbuild } from "esbuild";
import { rm } from "fs/promises";

async function buildAll() {
  await rm("dist", { recursive: true, force: true });
  console.log("Building Tasleem API...");
  await esbuild({
    entryPoints: ["server/index.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/index.cjs",
    define: { "process.env.NODE_ENV": '"production"' },
    minify: true,
    external: ["pg-native"],
    alias: { "@shared": "./shared" },
    logLevel: "info",
  });
  console.log("Build complete!");
}

buildAll().catch((err) => { console.error(err); process.exit(1); });
