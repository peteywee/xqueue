import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  AuthoringContractError,
  assertApproval,
  assertApprovalForCandidate,
  assertArtifactCandidate,
  digestObject,
} from './contracts.mjs';

export const DEFAULT_AUTHORING_ROOT = '.xqueue-author';

function safeName(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]+/g, '_');
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, path);
  return path;
}

export async function readAuthoringJson(path) {
  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

export function resolveAuthoringRoot(root = DEFAULT_AUTHORING_ROOT) {
  return resolve(root);
}

export async function saveAuthoringRun(run, { root = DEFAULT_AUTHORING_ROOT } = {}) {
  if (!run || typeof run !== 'object' || !run.source?.source_id) {
    throw new AuthoringContractError('invalid_authoring_run', 'authoring run requires a source record');
  }
  const runId = `run-${safeName(run.source.source_id)}-${digestObject({ source: run.source.content_digest, units: run.knowledgeUnits?.map((u) => u.knowledge_unit_id) ?? [] }).slice(-12)}`;
  const path = join(resolveAuthoringRoot(root), 'runs', `${runId}.json`);
  await writeJsonAtomic(path, { run_id: runId, ...run });
  return Object.freeze({ runId, path });
}

export async function saveReviewPacket(packet, { root = DEFAULT_AUTHORING_ROOT } = {}) {
  if (!packet?.candidate_id || !packet?.candidate_digest) {
    throw new AuthoringContractError('invalid_review_packet', 'review packet requires candidate id and digest');
  }
  const path = join(resolveAuthoringRoot(root), 'reviews', `${safeName(packet.candidate_id)}-${packet.candidate_digest.slice(-12)}.json`);
  await writeJsonAtomic(path, packet);
  return path;
}

export function createExplicitOwnerApproval({
  candidate,
  exactDigest,
  decision,
  decidedAt,
  attestations = [],
  notes = null,
}) {
  assertArtifactCandidate(candidate);
  if (exactDigest !== candidate.content_digest) {
    throw new AuthoringContractError('explicit_digest_mismatch', 'supplied exact digest does not match the candidate under review');
  }
  if (!['approve', 'reject'].includes(decision)) {
    throw new AuthoringContractError('explicit_owner_decision_required', 'decision must be approve or reject');
  }
  const approval = {
    approval_id: `approval:${digestObject({ candidate: candidate.content_digest, decision, decidedAt }).slice(-20)}`,
    candidate_id: candidate.candidate_id,
    candidate_digest: candidate.content_digest,
    decision,
    decided_by: 'Patrick Craven',
    decided_at: decidedAt,
    attestations,
    notes,
  };
  assertApproval(approval);
  if (decision === 'approve') assertApprovalForCandidate(candidate, approval);
  return Object.freeze(approval);
}

export async function saveApproval(approval, { root = DEFAULT_AUTHORING_ROOT } = {}) {
  assertApproval(approval);
  const path = join(resolveAuthoringRoot(root), 'approvals', `${safeName(approval.approval_id)}.json`);
  await writeJsonAtomic(path, approval);
  return path;
}

export async function savePromotionPlan(plan, { root = DEFAULT_AUTHORING_ROOT } = {}) {
  if (!plan?.status || !['ready', 'already_promoted'].includes(plan.status)) {
    throw new AuthoringContractError('invalid_promotion_plan', 'promotion plan must be ready or already_promoted');
  }
  const identity = plan.promotion?.promotion_id ?? `${plan.status}-${plan.postId ?? plan.artifactRef ?? 'unknown'}`;
  const path = join(resolveAuthoringRoot(root), 'promotion-plans', `${safeName(identity)}.json`);
  await writeJsonAtomic(path, plan);
  return path;
}
