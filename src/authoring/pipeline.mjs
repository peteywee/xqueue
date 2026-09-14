import { normalizeSourceInput, segmentSource } from './intake.mjs';
import { distillSegments } from './distiller.mjs';
import { createArtifactPlan } from './planner.mjs';
import { createDeterministicCandidate, withCandidateValidation } from './candidate.mjs';
import { validateArtifactForReview } from './authoring-validator.mjs';

export function runDeterministicAuthoring({
  source,
  requestedKind = 'auto',
  pillar = null,
  figure = null,
  createdAt,
  libraryPosts = [],
  figuresAvailable = null,
}) {
  const normalized = normalizeSourceInput(source);
  const segments = segmentSource(normalized);
  const units = distillSegments(normalized.record, segments);
  const plans = units.map((unit) => createArtifactPlan(unit, { requestedKind }));

  const candidates = [];
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    const plan = plans[index];
    if (plan.status !== 'ready') continue;

    for (const artifactKind of plan.eligibleKinds) {
      const draft = createDeterministicCandidate({
        unit,
        artifactKind,
        pillar: artifactKind === 'post' ? pillar : null,
        figure: artifactKind === 'post' ? figure : null,
        createdAt,
      });
      const validation = validateArtifactForReview({
        candidate: draft,
        knowledgeUnits: units,
        sourceRecords: [normalized.record],
        libraryPosts,
        figuresAvailable,
      });
      candidates.push(withCandidateValidation(draft, validation));
    }
  }

  return Object.freeze({
    source: normalized.record,
    segments,
    knowledgeUnits: units,
    plans,
    candidates,
  });
}
