#!/usr/bin/env node
/**
 * install-doc-scripts.mjs — add the documentation scripts to package.json.
 *
 * The contracts README documents `pnpm doc:stamp`, `pnpm doc:stamp:check`, and
 * `pnpm contract:lint`. Documenting a command that nothing installs is the same
 * class of defect the contracts are meant to prevent, so this installs them.
 *
 * Idempotent: re-running changes nothing. Existing entries are left alone and
 * reported, never overwritten — if a script name is already taken, that is a
 * decision someone made, and this tool does not get to reverse it.
 *
 * Usage:
 *   node scripts/install-doc-scripts.mjs           write the entries
 *   node scripts/install-doc-scripts.mjs --check   exit 1 if any are missing
 *
 * Exit codes: 0 present or written · 1 missing in --check mode ·
 * 2 no package.json, or it could not be parsed.
 */

import { readFileSync, writeFileSync } from "node:fs";

const WANTED = {
  "doc:stamp": "node scripts/doc-stamp.mjs",
  "doc:stamp:check": "node scripts/doc-stamp.mjs --check",
  "contract:lint": "node scripts/contract-lint.mjs",
};

const check = process.argv.includes("--check");
const path = "package.json";

let raw;
try {
  raw = readFileSync(path, "utf8");
} catch {
  console.error(`install-doc-scripts: no ${path} in the current directory.`);
  console.error("Run this from the repository root.");
  process.exit(2);
}

let pkg;
try {
  pkg = JSON.parse(raw);
} catch (err) {
  console.error(`install-doc-scripts: ${path} is not valid JSON — ${err.message}`);
  process.exit(2);
}

pkg.scripts ??= {};

const missing = [];
const conflicting = [];

for (const [name, command] of Object.entries(WANTED)) {
  const existing = pkg.scripts[name];
  if (existing === command) continue;
  if (existing === undefined) missing.push(name);
  else conflicting.push([name, existing, command]);
}

for (const [name, existing, wanted] of conflicting) {
  console.warn(`WARN  "${name}" already exists and was left alone:`);
  console.warn(`        current: ${existing}`);
  console.warn(`        wanted:  ${wanted}`);
}

if (check) {
  if (missing.length) {
    console.error(`install-doc-scripts: missing ${missing.map((n) => `"${n}"`).join(", ")}.`);
    console.error("Run: node scripts/install-doc-scripts.mjs");
    process.exit(1);
  }
  console.log("install-doc-scripts: all documentation scripts present.");
  process.exit(0);
}

if (!missing.length) {
  console.log(
    conflicting.length
      ? `install-doc-scripts: nothing added; ${conflicting.length} entr${conflicting.length === 1 ? "y" : "ies"} already defined differently and left alone.`
      : "install-doc-scripts: nothing to do; all entries already present.",
  );
  process.exit(0);
}

for (const name of missing) pkg.scripts[name] = WANTED[name];

const indent = raw.match(/\n(\s+)"/)?.[1] ?? "  ";
const trailingNewline = raw.endsWith("\n") ? "\n" : "";
writeFileSync(path, JSON.stringify(pkg, null, indent) + trailingNewline, "utf8");

console.log(`install-doc-scripts: added ${missing.map((n) => `"${n}"`).join(", ")} to ${path}.`);
