// validate.mjs — mechanical enforcement of the rules in §7 of the plan,
// plus the X platform constraints that cost money or reach.
//
// Every rule here exists because breaking it is expensive: an employment
// problem, a wage-claim exposure, a $0.20 API charge instead of $0.015,
// or an automation-policy strike.

import { renderPost } from './parse.mjs';

export const EMPLOYER_BLOCKLIST = [
  'uncle julio',
  'sun holdings',
  'legends hospitality',
  "at&t stadium",
  'att stadium',
];

export const CLAIM_PATTERNS = [
  /\b(?:our|my) (?:client|customer)s?\b/i,
  /\ba (?:pilot|rollout|deployment) (?:with|at)\b/i,
  /\bwe (?:deployed|rolled out|installed) (?:it )?at\b/i,
  /\b\d+\s+(?:restaurants?|locations?|units?)\s+(?:use|using|are using|have adopted)\b/i,
  /\b(?:our|my|a)\s+case study\b/i,
];

export const LIMIT_FREE = 280;
export const LIMIT_PREMIUM = 25000;
export const URL_RE = /https?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+\.(?:com|net|org|io|co|app|dev)\b/i;
export const EMOJI_RE = /\p{Extended_Pictographic}/u;
export const HASHTAG_RE = /(?:^|\s)#(?=\w*[a-z])\w+/i;

function normalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function similarity(a, b) {
  const grams = (s) => {
    const w = normalize(s).split(' ');
    const g = new Set();
    for (let i = 0; i + 2 < w.length; i++) g.add(w.slice(i, i + 3).join(' '));
    return g;
  };
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}

export function validate(posts, opts = {}) {
  const {
    premium = true,
    similarityThreshold = 0.35,
    figuresAvailable = null,
    requireFigures = false,
  } = opts;

  const findings = [];
  const add = (level, id, rule, message) => findings.push({ level, id, rule, message });

  const seen = new Map();

  for (const p of posts) {
    const text = renderPost(p);

    if (seen.has(p.id)) add('error', p.id, 'unique-id', `Duplicate id, also at ${seen.get(p.id).sourceFile}:${seen.get(p.id).sourceLine}`);
    else seen.set(p.id, p);

    if (!p.body || p.body.length < 40) add('error', p.id, 'body', 'Body missing or implausibly short');

    for (const name of EMPLOYER_BLOCKLIST) {
      if (text.toLowerCase().includes(name)) {
        add('error', p.id, 'employer-name', `Contains blocked employer reference: "${name}"`);
      }
    }

    for (const re of CLAIM_PATTERNS) {
      if (re.test(text)) add('error', p.id, 'unauthorized-claim', `Matches claim pattern ${re}`);
    }

    if (p.pillar === 'B' && !/not legal advice/i.test(text)) {
      add('error', p.id, 'missing-disclaimer', 'Pillar B post has no disclaimer');
    }
    if (p.pillar !== 'B' && /not legal advice/i.test(text)) {
      add('warn', p.id, 'stray-disclaimer', 'Non-B post carries a legal disclaimer — check the pillar assignment');
    }

    const limit = premium ? LIMIT_PREMIUM : LIMIT_FREE;
    if (text.length > limit) {
      add('error', p.id, 'length', `${text.length} chars exceeds ${limit}`);
    } else if (!premium && text.length > LIMIT_FREE) {
      add('error', p.id, 'length', `${text.length} chars needs an X subscription (280 without one)`);
    }
    if (premium && text.length > LIMIT_FREE) {
      add('info', p.id, 'length', `${text.length} chars — long post, requires an active X subscription`);
    }

    if (URL_RE.test(p.body)) {
      add('warn', p.id, 'url-in-body', 'Contains a URL — 13x the API cost and a reach penalty. Put links in a reply.');
    }

    if (EMOJI_RE.test(text)) add('warn', p.id, 'emoji', 'Contains emoji — off-voice for this account');
    if (HASHTAG_RE.test(text)) add('warn', p.id, 'hashtag', 'Contains a hashtag — off-voice for this account');

    if (p.figure != null) {
      if (figuresAvailable === null) {
        if (requireFigures) {
          add('error', p.id, 'figure-check-unavailable', `References figure ${p.figure}; media inventory is unavailable`);
        }
      } else if (figuresAvailable.size === 0) {
        add(
          requireFigures ? 'error' : 'info',
          p.id,
          requireFigures ? 'missing-figure' : 'figure-unchecked',
          requireFigures
            ? `References figure ${p.figure}, but the media directory is empty`
            : `References figure ${p.figure}; media directory is empty, not checked`,
        );
      } else if (!figuresAvailable.has(p.figure)) {
        add('error', p.id, 'missing-figure', `References figure ${p.figure}, which is not in the media directory`);
      }
    }
  }

  for (let i = 0; i < posts.length; i++) {
    for (let j = i + 1; j < posts.length; j++) {
      const s = similarity(posts[i].body, posts[j].body);
      if (s >= similarityThreshold) {
        add('warn', posts[i].id, 'near-duplicate', `${Math.round(s * 100)}% trigram overlap with ${posts[j].id} — X policy prohibits substantially similar posts`);
      }
    }
  }

  return findings;
}

export function summarize(findings) {
  const counts = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.level]++;
  return counts;
}
