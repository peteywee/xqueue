#!/usr/bin/env node
/**
 * contract-lint.mjs — structural integrity of the contract set.
 *
 * What it checks:
 *   1. Anchor block present, valid JSON, required keys, known truth state
 *   2. Header rows present (Status, Version, Created, Last updated) and a
 *      status from the allowed vocabulary
 *   3. Requirement IDs unique within a document
 *   4. Every requirement definition carries a normative keyword
 *   5. Every cross-reference to a requirement ID resolves to a definition
 *      somewhere in the set (dangling references are the quiet killer)
 *   6. Every OQ- reference resolves to a row in that document's open
 *      questions table, or to a line recording it as closed
 *   7. Reports MUST requirements with no acceptance case (warning by default,
 *      fatal under --strict)
 *
 * What it does NOT check: whether any requirement is implemented. Nothing in
 * this repository checks that. Implementation verification requires running
 * the code.
 *
 * Usage:
 *   node scripts/contract-lint.mjs
 *   node scripts/contract-lint.mjs --strict          warnings become errors
 *   node scripts/contract-lint.mjs --dir docs/contracts
 *
 * Exit codes: 0 clean · 1 defects found · 2 usage or environment error.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const dirFlag = args.indexOf("--dir");
const root = dirFlag === -1 ? "docs/contracts" : args[dirFlag + 1];

if (!root) {
  console.error("contract-lint: --dir needs a path");
  process.exit(2);
}

try {
  statSync(root);
} catch {
  console.error(`contract-lint: directory not found: ${root}`);
  process.exit(2);
}

const TRUTH_STATES = new Set([
  "verified", "declared", "inferred", "unknown",
  "conflicting", "stale", "not_applicable", "proposed", "planned",
]);
const STATUSES = ["proposed", "active", "superseded"];
const NORMATIVE = /\b(MUST NOT|MUST|SHOULD NOT|SHOULD|MAY)\b/;

const ANCHOR_RE = /<!--tos-doc\s*([\s\S]*?)-->/;
const DEF_RE = /\*\*([A-Z]{2,6})-(\d+)\*\*/g;
const REF_RE = /\b([A-Z]{2,6})-(\d+)(?![\d\w-])/g;
const OQ_DEF_RE = /\bOQ-([A-Z]{2,6})-(\d+)\b/g;
const ROW_ID_RE = /^\|\s*`?([A-Z]{2,6}-\d+)`?\s*\|/;

function markdownFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...markdownFiles(full));
    else if (entry.name.endsWith(".md")) out.push(full);
  }
  return out.sort();
}

function stripFences(text) {
  return text.replace(/```[\s\S]*?```/g, "").replace(/^ {4}.*$/gm, "");
}

const errors = [];
const warnings = [];
const docs = [];
const definedIds = new Set();

for (const file of markdownFiles(root)) {
  const raw = readFileSync(file, "utf8");
  const body = stripFences(raw);
  const doc = { file, raw, body, ids: new Set(), prefix: null, class: null, oqs: new Set(), exempt: new Set() };

  // 1. anchor
  const anchor = raw.match(ANCHOR_RE);
  if (!anchor) {
    errors.push(`${file}: no <!--tos-doc --> anchor block`);
  } else {
    let meta;
    try {
      meta = JSON.parse(anchor[1]);
    } catch (err) {
      errors.push(`${file}: anchor JSON is invalid — ${err.message}`);
    }
    if (meta) {
      doc.class = meta.class ?? null;
      for (const key of ["doc_id", "class", "claims_truth_state", "written_against", "depends_on"]) {
        if (!(key in meta)) errors.push(`${file}: anchor missing "${key}"`);
      }
      if (meta.claims_truth_state && !TRUTH_STATES.has(meta.claims_truth_state)) {
        errors.push(`${file}: unknown claims_truth_state "${meta.claims_truth_state}"`);
      }
      if (meta.written_against && !("head_sha" in meta.written_against)) {
        errors.push(`${file}: written_against missing "head_sha"`);
      }
      if (meta.depends_on && !Array.isArray(meta.depends_on)) {
        errors.push(`${file}: depends_on must be an array`);
      }
      if (meta.claims_truth_state === "verified" && meta.written_against?.head_sha === "Not yet verified") {
        errors.push(`${file}: claims verified with no anchor SHA`);
      }
    }
  }

  // 2. header rows — contracts only; review and evidence records have their own shape
  const headerRows = doc.class === "contract"
    ? ["Status", "Version", "Created", "Last updated"]
    : ["Created", "Last updated"];
  for (const row of headerRows) {
    if (!new RegExp(`^\\|\\s*${row}\\s*\\|`, "m").test(raw)) {
      errors.push(`${file}: header table missing a "${row}" row`);
    }
  }
  const status = raw.match(/^\|\s*Status\s*\|\s*([a-z]+)/m);
  if (doc.class === "contract" && status && !STATUSES.includes(status[1])) {
    errors.push(`${file}: status "${status[1]}" is not one of ${STATUSES.join(", ")}`);
  }

  // 3 + 4. requirement definitions
  const prefixCount = new Map();
  for (const m of body.matchAll(DEF_RE)) {
    const id = `${m[1]}-${m[2]}`;
    if (doc.ids.has(id)) errors.push(`${file}: requirement ${id} defined more than once`);
    doc.ids.add(id);
    definedIds.add(id);
    prefixCount.set(m[1], (prefixCount.get(m[1]) ?? 0) + 1);

    const at = m.index;
    const paragraph = body.slice(at, body.indexOf("\n\n", at) === -1 ? undefined : body.indexOf("\n\n", at));
    if (!NORMATIVE.test(paragraph)) {
      errors.push(`${file}: ${id} has no normative keyword (MUST / SHOULD / MAY)`);
    }
    doc[id] = paragraph;
  }
  for (const m of raw.matchAll(/<!--\s*lint-exempt-acceptance:\s*([^>]*?)-->/g)) {
    for (const id of m[1].split(",")) {
      const trimmed = id.trim();
      if (trimmed) doc.exempt.add(trimmed);
    }
  }

  for (const line of raw.split("\n")) {
    const isTableRow = /^\|\s*OQ-/.test(line.trim());
    const isClosure = /closed/i.test(line);
    if (!isTableRow && !isClosure) continue;
    for (const m of line.matchAll(OQ_DEF_RE)) doc.oqs.add(`OQ-${m[1]}-${m[2]}`);
  }

  doc.prefix = [...prefixCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  docs.push(doc);
}

// 5. cross-references resolve
for (const doc of docs) {
  const seen = new Set();
  for (const m of doc.body.matchAll(REF_RE)) {
    const prefix = m[1];
    if (!["PUB", "AUTH", "STATE", "WF", "SCHED"].includes(prefix)) continue;
    const id = `${prefix}-${m[2]}`;
    if (seen.has(id) || definedIds.has(id)) continue;
    seen.add(id);
    errors.push(`${doc.file}: reference to ${id} which is not defined anywhere in the set`);
  }
}

// 6. open-question references resolve somewhere in the set
const declaredOqs = new Set();
for (const doc of docs) for (const id of doc.oqs) declaredOqs.add(id);

for (const doc of docs) {
  const seen = new Set();
  for (const m of doc.body.matchAll(OQ_DEF_RE)) {
    const id = `OQ-${m[1]}-${m[2]}`;
    if (seen.has(id) || declaredOqs.has(id)) continue;
    seen.add(id);
    errors.push(`${doc.file}: ${id} referenced but has no open-questions row anywhere in the set and is not recorded as closed`);
  }
}

// 7. acceptance coverage
for (const doc of docs) {
  const proven = new Set();
  for (const line of doc.raw.split("\n")) {
    if (!/^\|\s*`?[A-Z]{2,6}-AC-\d+`?\s*\|/.test(line.trim())) continue;
    for (const m of line.matchAll(REF_RE)) proven.add(`${m[1]}-${m[2]}`);
  }
  const uncovered = [...doc.ids].filter(
    (id) => /MUST/.test(doc[id] ?? "") && !proven.has(id) && !doc.exempt.has(id),
  );
  if (uncovered.length) {
    warnings.push(`${doc.file}: ${uncovered.length} MUST requirement${uncovered.length === 1 ? "" : "s"} with no acceptance case — ${uncovered.join(", ")}`);
  }
}

for (const w of warnings) console.warn(`WARN  ${w}`);
for (const e of errors) console.error(`ERROR ${e}`);

const fatal = errors.length + (strict ? warnings.length : 0);
console.log(
  `\ncontract-lint: ${docs.length} documents, ${definedIds.size} requirements, ` +
    `${errors.length} errors, ${warnings.length} warnings${strict ? " (strict: warnings are fatal)" : ""}.`,
);
process.exit(fatal > 0 ? 1 : 0);
