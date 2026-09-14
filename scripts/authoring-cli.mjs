import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { loadLibrary } from '../src/parse.mjs';
import { runDeterministicAuthoring } from '../src/authoring/pipeline.mjs';
import { createOwnerReviewPacket } from '../src/authoring/review.mjs';
import { planNonPostPromotion, planPostPromotion } from '../src/authoring/promotion.mjs';
import {
  createExplicitOwnerApproval,
  readAuthoringJson,
  saveApproval,
  saveAuthoringRun,
  savePromotionPlan,
  saveReviewPacket,
} from '../src/authoring/workspace.mjs';

function usage(message = null) {
  if (message) console.error(`ERROR: ${message}`);
  console.error(`
XQueue Author local workflow

  pnpm author:distill -- --input <file> --kind <post|blog|lesson> [options]
  pnpm author:review -- --run <run.json> --candidate-id <id>
  pnpm author:approve -- --run <run.json> --candidate-id <id> --digest <sha256:...> --decision <approve|reject>
  pnpm author:promotion-plan -- --run <run.json> --candidate-id <id> --approval <approval.json>

Distill options:
  --source-type <owner_input|conversation|github|document|context_engine|generated_content>
  --trust-class <owner_attested|authoritative_reference|evidence|generated|unverified>
  --owner-attest               required when trust-class=owner_attested
  --locator <source locator>    defaults to file:<absolute path>
  --observed-at <ISO time>      defaults to current time
  --project <project>
  --sensitivity <public|internal|sensitive|restricted>
  --pillar <A|B|C|D>            required for post
  --workspace <path>            defaults to .xqueue-author

Promotion-plan never writes content/*.md. It writes a plan into the local workspace only.
`);
  process.exitCode = 2;
}

function parseFlags(tokens) {
  const flags = {};
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = tokens[i + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return flags;
}

function requireFlag(flags, name) {
  const value = flags[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name} is required`);
  return value;
}

function findCandidate(run, id) {
  const candidate = run?.candidates?.find((item) => item.candidate_id === id);
  if (!candidate) throw new Error(`candidate not found in run: ${id}`);
  return candidate;
}

async function distill(flags) {
  const inputPath = resolve(requireFlag(flags, 'input'));
  const kind = requireFlag(flags, 'kind');
  const text = await readFile(inputPath, 'utf8');
  const sourceType = flags['source-type'] || 'document';
  const trustClass = flags['trust-class'] || (sourceType === 'generated_content' ? 'generated' : 'unverified');
  if (trustClass === 'owner_attested' && flags['owner-attest'] !== true) {
    throw new Error('--owner-attest is required to classify input as owner_attested');
  }
  if (sourceType === 'generated_content' && !['generated', 'unverified'].includes(trustClass)) {
    throw new Error('generated_content may only use generated or unverified trust class');
  }
  const pillar = flags.pillar || null;
  if (kind === 'post' && !['A', 'B', 'C', 'D'].includes(pillar)) {
    throw new Error('--pillar A|B|C|D is required for post');
  }

  const now = flags['observed-at'] || new Date().toISOString();
  const sourceId = flags['source-id'] || `local-${basename(inputPath).replace(/[^a-zA-Z0-9._-]+/g, '_')}`;
  const libraryPosts = loadLibrary(join(process.cwd(), 'content'));
  const run = runDeterministicAuthoring({
    source: {
      sourceId,
      sourceType,
      trustClass,
      locator: flags.locator || `file:${inputPath}`,
      observedAt: now,
      text,
      project: flags.project || null,
      sensitivity: flags.sensitivity || 'internal',
      metadata: { input_file: inputPath },
    },
    requestedKind: kind,
    pillar,
    createdAt: now,
    libraryPosts,
  });
  const saved = await saveAuthoringRun(run, { root: flags.workspace });
  console.log(JSON.stringify({ status: 'saved', run_id: saved.runId, path: saved.path, candidates: run.candidates.map((c) => ({ id: c.candidate_id, status: c.status, validation: c.validation.result })) }, null, 2));
}

async function review(flags) {
  const run = await readAuthoringJson(resolve(requireFlag(flags, 'run')));
  const candidate = findCandidate(run, requireFlag(flags, 'candidate-id'));
  const reviewedAt = flags['reviewed-at'] || new Date().toISOString();
  const libraryPosts = loadLibrary(join(process.cwd(), 'content'));
  const packet = createOwnerReviewPacket({
    candidate,
    knowledgeUnits: run.knowledgeUnits,
    sourceRecords: [run.source],
    validation: candidate.validation,
    approvedCorpus: libraryPosts,
    priorArtifacts: [],
    reviewedAt,
  });
  const path = await saveReviewPacket(packet, { root: flags.workspace });
  console.log(JSON.stringify({ status: 'saved', path, ready_for_owner_decision: packet.ready_for_owner_decision, blocking_findings: packet.blocking_findings }, null, 2));
}

async function approve(flags) {
  const run = await readAuthoringJson(resolve(requireFlag(flags, 'run')));
  const candidate = findCandidate(run, requireFlag(flags, 'candidate-id'));
  const approval = createExplicitOwnerApproval({
    candidate,
    exactDigest: requireFlag(flags, 'digest'),
    decision: requireFlag(flags, 'decision'),
    decidedAt: flags['decided-at'] || new Date().toISOString(),
    attestations: flags.attestation ? [String(flags.attestation)] : [],
    notes: typeof flags.notes === 'string' ? flags.notes : null,
  });
  const path = await saveApproval(approval, { root: flags.workspace });
  console.log(JSON.stringify({ status: 'saved', path, approval_id: approval.approval_id, decision: approval.decision, candidate_digest: approval.candidate_digest }, null, 2));
}

async function promotionPlan(flags) {
  const run = await readAuthoringJson(resolve(requireFlag(flags, 'run')));
  const candidate = findCandidate(run, requireFlag(flags, 'candidate-id'));
  const approval = await readAuthoringJson(resolve(requireFlag(flags, 'approval')));
  const promotedAt = flags['promoted-at'] || new Date().toISOString();
  const libraryPosts = loadLibrary(join(process.cwd(), 'content'));
  const plan = candidate.artifact_kind === 'post'
    ? planPostPromotion({ candidate, approval, existingPosts: libraryPosts, promotedAt })
    : planNonPostPromotion({ candidate, approval, promotedAt });
  const path = await savePromotionPlan(plan, { root: flags.workspace });
  console.log(JSON.stringify({ status: 'planned', path, promotion_status: plan.status, destination: plan.targetPath || plan.destination, artifact_ref: plan.postId || plan.artifactRef }, null, 2));
}

const [command, ...tokens] = process.argv.slice(2);
if (!command) {
  usage();
} else {
  try {
    const flags = parseFlags(tokens);
    if (command === 'distill') await distill(flags);
    else if (command === 'review') await review(flags);
    else if (command === 'approve') await approve(flags);
    else if (command === 'promotion-plan') await promotionPlan(flags);
    else usage(`unknown command: ${command}`);
  } catch (error) {
    console.error(`ERROR: ${error?.code ? `${error.code}: ` : ''}${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
