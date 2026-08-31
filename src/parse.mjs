// parse.mjs — read the pillar markdown files, emit structured posts.
// The markdown IS the source of truth. Edit the markdown, rebuild the queue.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const HEADING = /^\*\*([ABCD])(\d+)\s+·\s+(.+?)\*\*(?:\s*\*\((.+?)\)\*)?\s*$/;

export const PILLARS = {
  A: { name: 'Translation', share: 0.40 },
  B: { name: 'Labor law', share: 0.25 },
  C: { name: 'Building in public', share: 0.20 },
  D: { name: 'Method', share: 0.15 },
};

export const DISCLAIMER =
  'General information, not legal advice. Wage and hour rules vary by\n' +
  'state — talk to an employment attorney about your situation.';

export const DISCLAIMER_SHORT =
  'General info, not legal advice. Rules vary by state.';

/** Pull `figure N` out of an annotation like "attach figure 14" or "pinned post; attach figure 14". */
function parseNote(note) {
  if (!note) return { figure: null, pinned: false, note: null };
  const fig = note.match(/figure\s+(\d+)/i);
  return {
    figure: fig ? Number(fig[1]) : null,
    pinned: /pinned/i.test(note),
    note,
  };
}

export function parseFile(path) {
  const lines = readFileSync(path, 'utf8').split('\n');
  const posts = [];
  let current = null;
  let inFence = false;
  let buf = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const head = line.match(HEADING);

    if (head && !inFence) {
      const [, pillar, num, title, note] = head;
      current = {
        id: `${pillar}${num}`,
        pillar,
        seq: Number(num),
        title: title.trim(),
        ...parseNote(note),
        body: null,
        sourceFile: path,
        sourceLine: i + 1,
      };
      continue;
    }

    if (line.trim() === '```') {
      if (!inFence) {
        // Only open a capture fence if we're waiting on a body for a post.
        if (current && current.body === null) { inFence = true; buf = []; }
        continue;
      }
      inFence = false;
      if (current && current.body === null) {
        current.body = buf.join('\n').trim();
        posts.push(current);
        current = null;
      }
      continue;
    }

    if (inFence) buf.push(line);
  }

  return posts;
}

export function loadLibrary(dir) {
  const files = readdirSync(dir)
    .filter((f) => /pillar-[abcd]\.md$/i.test(f))
    .sort()
    .map((f) => join(dir, f));

  const posts = files.flatMap(parseFile);
  posts.sort((a, b) => (a.pillar === b.pillar ? a.seq - b.seq : a.pillar.localeCompare(b.pillar)));
  return posts;
}

/** Full text as it would go on the wire, disclaimer included for pillar B. */
export function renderPost(post, { shortDisclaimer = false } = {}) {
  if (post.pillar !== 'B') return post.body;
  const d = shortDisclaimer ? DISCLAIMER_SHORT : DISCLAIMER;
  return `${post.body}\n\n${d}`;
}
