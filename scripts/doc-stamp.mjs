#!/usr/bin/env node
/**
 * doc-stamp.mjs — keep the "Last updated" stamp in governed docs honest.
 *
 * Scope, stated plainly: this checks timestamp integrity and nothing else. It
 * compares the "Last updated" row against the last git commit that touched
 * that document, and rewrites or reports it.
 *
 * It does NOT inspect depends_on, compare dependency commits, validate
 * written_against.head_sha, or judge whether a document is still true.
 * For structural checks, see contract-lint.mjs.
 *
 * A dirty file stamps as today (UTC), because it is being edited right now.
 * Only the header metadata row is touched:
 *
 *     | Last updated | 2026-09-03 |
 *
 * Index tables listing several documents are left alone — the script cannot
 * know which row belongs to which file.
 *
 * Usage:
 *   node scripts/doc-stamp.mjs                 rewrite stamps under docs/
 *   node scripts/doc-stamp.mjs --check         exit 1 if any stamp is wrong
 *   node scripts/doc-stamp.mjs --dir docs/contracts
 *
 * Exit codes: 0 correct or written · 1 drift found in --check mode ·
 * 2 usage or environment error.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const STAMP_RE = /^(\|\s*Last updated\s*\|\s*)(.*?)(\s*\|\s*)$/m;

const args = process.argv.slice(2);
const check = args.includes("--check");
const dirFlag = args.indexOf("--dir");
const root = dirFlag === -1 ? "docs" : args[dirFlag + 1];

if (!root) {
  console.error("doc-stamp: --dir needs a path");
  process.exit(2);
}

function git(cmdArgs) {
  return execFileSync("git", cmdArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

try {
  git(["rev-parse", "--is-inside-work-tree"]);
} catch {
  console.error("doc-stamp: not a git repository");
  process.exit(2);
}

try {
  statSync(root);
} catch {
  console.error(`doc-stamp: directory not found: ${root}`);
  process.exit(2);
}

function markdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(full));
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out.sort();
}

function gitDateFor(file) {
  const path = relative(process.cwd(), file) || file;
  let dirty = true;
  try {
    dirty = git(["status", "--porcelain", "--", path]).length > 0;
  } catch {
    dirty = true;
  }
  if (dirty) return new Date().toISOString().slice(0, 10);

  let iso = "";
  try {
    iso = git(["log", "-1", "--format=%cI", "--", path]);
  } catch {
    iso = "";
  }
  return iso ? iso.slice(0, 10) : new Date().toISOString().slice(0, 10);
}

const files = markdownFiles(root);
let drift = 0;
let written = 0;
let skipped = 0;

for (const file of files) {
  const text = readFileSync(file, "utf8");
  const match = text.match(STAMP_RE);
  if (!match) {
    skipped += 1;
    continue;
  }

  const current = match[2].trim();
  const expected = gitDateFor(file);
  if (current === expected) continue;

  if (check) {
    drift += 1;
    console.error(`STALE  ${file}  says "${current}", git says "${expected}"`);
  } else {
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(file, text.replace(STAMP_RE, `$1${today}$3`), "utf8");
    written += 1;
    console.log(`stamped ${file}  ${current || "(empty)"} -> ${today}`);
  }
}

const scanned = files.length - skipped;

if (check) {
  if (drift > 0) {
    console.error(`\ndoc-stamp: ${drift} of ${scanned} stamped docs are out of date.`);
    console.error("Run: pnpm doc:stamp");
    process.exit(1);
  }
  console.log(`doc-stamp: ${scanned} stamped docs current (${skipped} without a stamp row).`);
  process.exit(0);
}

console.log(`doc-stamp: ${written} updated, ${scanned - written} already current, ${skipped} without a stamp row.`);
