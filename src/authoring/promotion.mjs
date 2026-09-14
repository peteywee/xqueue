import {
  AuthoringContractError,
  assertApprovalForCandidate,
  assertArtifactCandidate,
  digestObject,
} from './contracts.mjs';

const TARGETS = Object.freeze({
  A: 'content/20-pillar-a.md',
  B: 'content/30-pillar-b.md',
  C: 'content/40-pillar-c.md',
  D: 'content/50-pillar-d.md',
});

function nextPostId(pillar, existingPosts) {
  const seqs = existingPosts
    .filter((post) => post.pillar === pillar)
    .map((post) => Number(post.seq))
    .filter(Number.isFinite);
  const next = (seqs.length ? Math.max(...seqs) : 0) + 1;
  return `${pillar}${next}`;
}

export function createPromotionRecord({ candidate, approval, destination, promotedAt, artifactRef }) {
  assertApprovalForCandidate(candidate, approval);
  if (typeof destination !== 'string' || !destination.trim()) {
    throw new AuthoringContractError('destination_required', 'promotion destination is required');
  }
  if (typeof artifactRef !== 'string' || !artifactRef.trim()) {
    throw new AuthoringContractError('artifact_ref_required', 'promotion artifactRef is required');
  }

  return Object.freeze({
    promotion_id: `promotion:${digestObject({ candidate: candidate.content_digest, destination, artifactRef }).slice(-20)}`,
    candidate_id: candidate.candidate_id,
    candidate_digest: candidate.content_digest,
    approval_id: approval.approval_id,
    destination,
    artifact_ref: artifactRef,
    promoted_at: promotedAt,
  });
}

export function renderPostMarkdown({ postId, title, body }) {
  if (!/^[ABCD]\d+$/.test(postId)) {
    throw new AuthoringContractError('invalid_post_id', 'postId must match pillar letter plus sequence');
  }
  return `\n\n**${postId} · ${title.trim()}**\n\`\`\`\n${body.trim()}\n\`\`\`\n`;
}

export function planPostPromotion({
  candidate,
  approval,
  existingPosts,
  priorPromotions = [],
  promotedAt,
}) {
  assertArtifactCandidate(candidate);
  assertApprovalForCandidate(candidate, approval);
  if (candidate.artifact_kind !== 'post') {
    throw new AuthoringContractError('post_candidate_required', 'post promotion accepts only post candidates');
  }
  if (!Array.isArray(existingPosts) || !Array.isArray(priorPromotions)) {
    throw new AuthoringContractError('invalid_promotion_context', 'existingPosts and priorPromotions must be arrays');
  }

  const targetPath = TARGETS[candidate.pillar];
  const duplicate = priorPromotions.find((record) =>
    record?.candidate_digest === candidate.content_digest && record?.destination === targetPath);

  if (duplicate) {
    return Object.freeze({
      status: 'already_promoted',
      targetPath: duplicate.destination,
      postId: duplicate.artifact_ref,
      markdown: null,
      promotion: duplicate,
    });
  }

  const postId = nextPostId(candidate.pillar, existingPosts);
  const promotion = createPromotionRecord({
    candidate,
    approval,
    destination: targetPath,
    promotedAt,
    artifactRef: postId,
  });

  return Object.freeze({
    status: 'ready',
    targetPath,
    postId,
    markdown: renderPostMarkdown({ postId, title: candidate.title, body: candidate.body }),
    promotion,
  });
}

export function applyPostPromotionToMarkdown(existingMarkdown, plan) {
  if (typeof existingMarkdown !== 'string') {
    throw new AuthoringContractError('invalid_target_markdown', 'existingMarkdown must be a string');
  }
  if (plan?.status === 'already_promoted') return existingMarkdown;
  if (plan?.status !== 'ready' || typeof plan.markdown !== 'string') {
    throw new AuthoringContractError('promotion_plan_required', 'a ready promotion plan is required');
  }
  if (existingMarkdown.includes(`**${plan.postId} ·`)) {
    throw new AuthoringContractError('post_id_collision', `${plan.postId} already exists in target markdown`);
  }
  return `${existingMarkdown.trimEnd()}${plan.markdown}`;
}
