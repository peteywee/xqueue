import { AuthoringContractError, assertArtifactCandidate } from './contracts.mjs';

const EMOJI_RE = /\p{Extended_Pictographic}/u;
const HASHTAG_RE = /(?:^|\s)#(?=\w*[a-z])\w+/i;
const FIRST_PERSON_RE = /\b(?:i|i'm|i’ve|i've|my|me|mine|we|we're|we’ve|we've|our|ours)\b/i;

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index];
}

export function buildStyleProfile(posts) {
  if (!Array.isArray(posts)) {
    throw new AuthoringContractError('invalid_style_corpus', 'style corpus must be an array');
  }
  const bodies = posts.map((post) => String(post?.body ?? '')).filter(Boolean);
  const lengths = bodies.map((body) => body.length);
  const paragraphs = bodies.map((body) => body.split(/\n\s*\n/).filter(Boolean).length);

  return Object.freeze({
    sampleSize: bodies.length,
    charP25: percentile(lengths, 0.25),
    charP50: percentile(lengths, 0.50),
    charP90: percentile(lengths, 0.90),
    paragraphP50: percentile(paragraphs, 0.50),
    emojiRate: bodies.length ? bodies.filter((body) => EMOJI_RE.test(body)).length / bodies.length : 0,
    hashtagRate: bodies.length ? bodies.filter((body) => HASHTAG_RE.test(body)).length / bodies.length : 0,
    firstPersonRate: bodies.length ? bodies.filter((body) => FIRST_PERSON_RE.test(body)).length / bodies.length : 0,
  });
}

export function evaluateCandidateStyle(candidate, profile) {
  assertArtifactCandidate(candidate);
  if (!profile || !Number.isInteger(profile.sampleSize)) {
    throw new AuthoringContractError('invalid_style_profile', 'style profile is required');
  }
  if (profile.sampleSize === 0) return [];

  const findings = [];
  const body = candidate.body;
  if (profile.emojiRate <= 0.05 && EMOJI_RE.test(body)) {
    findings.push({ level: 'warn', rule: 'style-emoji-deviation', message: 'Candidate uses emoji but the approved corpus almost never does' });
  }
  if (profile.hashtagRate <= 0.05 && HASHTAG_RE.test(body)) {
    findings.push({ level: 'warn', rule: 'style-hashtag-deviation', message: 'Candidate uses hashtags but the approved corpus almost never does' });
  }
  if (profile.charP25 && body.length < Math.max(40, Math.floor(profile.charP25 * 0.5))) {
    findings.push({ level: 'warn', rule: 'style-unusually-short', message: 'Candidate is materially shorter than the approved corpus' });
  }
  if (profile.charP90 && body.length > Math.ceil(profile.charP90 * 1.5)) {
    findings.push({ level: 'warn', rule: 'style-unusually-long', message: 'Candidate is materially longer than the approved corpus' });
  }
  if (candidate.artifact_kind === 'post' && candidate.pillar === 'C' && profile.firstPersonRate >= 0.25 && !FIRST_PERSON_RE.test(body)) {
    findings.push({ level: 'info', rule: 'style-first-person-signal', message: 'Building-in-public corpus often uses first person; review whether this should too' });
  }
  return findings;
}
