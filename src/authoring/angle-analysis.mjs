import { AuthoringContractError, assertArtifactCandidate } from './contracts.mjs';

const STOP = new Set(['the','a','an','and','or','but','to','of','in','on','for','with','is','are','was','were','be','been','being','it','that','this','as','at','by','from','i','my','we','our','you','your']);

function tokenSet(value) {
  return new Set(String(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2 && !STOP.has(token)));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

export function analyzeAngleReuse(candidate, priorArtifacts, { threshold = 0.55 } = {}) {
  assertArtifactCandidate(candidate);
  if (!Array.isArray(priorArtifacts)) {
    throw new AuthoringContractError('invalid_prior_artifacts', 'priorArtifacts must be an array');
  }
  if (typeof threshold !== 'number' || threshold <= 0 || threshold > 1) {
    throw new AuthoringContractError('invalid_angle_threshold', 'threshold must be greater than 0 and at most 1');
  }

  const candidateTokens = tokenSet(`${candidate.title}\n${candidate.body}`);
  const findings = [];

  for (const artifact of priorArtifacts) {
    const ref = artifact?.artifact_ref ?? artifact?.id ?? 'unknown-artifact';
    const similarity = jaccard(candidateTokens, tokenSet(`${artifact?.title ?? ''}\n${artifact?.body ?? ''}`));
    if (similarity >= threshold) {
      findings.push({
        level: 'warn',
        rule: 'angle-reuse',
        artifact_ref: ref,
        similarity,
        message: `Candidate overlaps ${ref} at ${Math.round(similarity * 100)}% token-set similarity`,
      });
    }
  }

  return findings.sort((a, b) => b.similarity - a.similarity);
}
