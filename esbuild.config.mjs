import esbuild from "esbuild";
import process from "process";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prod = process.argv[2] === "production";

// Obsidian plugin deploy target (absolute path)
const DEPLOY_DIR = path.join(
  process.env.USERPROFILE || process.env.HOME || "",
  "Proton Drive/fruehwirth.michael/My files/Documents (Cloud)/Obsidian - Dev/.obsidian/plugins/advanced-sync"
);

/** Copy built files to the Obsidian plugins directory. */
function deploy() {
  const files = ["main.js", "manifest.json", "styles.css"];
  fs.mkdirSync(DEPLOY_DIR, { recursive: true });
  for (const file of files) {
    const src = path.join(__dirname, file);
    const dst = path.join(DEPLOY_DIR, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
    }
  }
  console.log(`[deploy] Copied plugin files to ${DEPLOY_DIR}`);
}

/** esbuild plugin that deploys after each build. */
const deployPlugin = {
  name: "deploy",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length === 0) {
        deploy();
      }
    });
  },
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    "dgram",
    "os",
    // ws optional native modules - not needed, pure JS fallbacks are used
    "bufferutil",
    "utf-8-validate",
  ],
  alias: {
    "@vault-sync/shared": path.resolve(__dirname, "shared"),
  },
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
  plugins: [deployPlugin],
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
