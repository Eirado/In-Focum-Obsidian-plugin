// Builds the plugin with esbuild:
//
//   node build.mjs                  into dist/
//   node build.mjs --vault <path>   into <path>/.obsidian/plugins/in-focum, to install or update it there
//
// styles.css is src/styles.css plus one ramp per Flexoki color from src/colors.json.

import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

const here = import.meta.dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(here, "manifest.json"), "utf8"));
const argument = process.argv.indexOf("--vault");
const vault = argument > 0 ? process.argv[argument + 1] : undefined;
if (argument > 0 && (!vault || !fs.existsSync(path.join(vault, ".obsidian")))) throw new Error(`not an Obsidian vault: ${vault}`);
const out = vault ? path.join(vault, ".obsidian/plugins", manifest.id) : path.join(here, "dist");

fs.mkdirSync(out, { recursive: true });
await build({
  absWorkingDir: here,
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  external: ["obsidian"],
  outfile: path.join(out, "main.js"),
  logLevel: "warning",
});

const colors = JSON.parse(fs.readFileSync(path.join(here, "src/colors.json"), "utf8"));
const ramps = Object.entries(colors).flatMap(([mode, hues]) =>
  Object.entries(hues).map(
    ([hue, ramp]) =>
      `.theme-${mode} .gh-color-${hue} { ${ramp.hex.map((hex, i) => `--gh-${i + 1}: ${hex};`).join(" ")} --gh-done: ${ramp.done}; } /* Flexoki ${hue} ${ramp.steps.join("/")} */`,
  ),
);
const css = `${fs.readFileSync(path.join(here, "src/styles.css"), "utf8")}\n/* Color ramps: generated from colors.json, each validated for its theme. */\n${ramps.join("\n")}\n`;
fs.writeFileSync(path.join(out, "styles.css"), css);
fs.copyFileSync(path.join(here, "manifest.json"), path.join(out, "manifest.json"));
console.log(`built ${out}: main.js, styles.css (${ramps.length} ramps), manifest.json`);
