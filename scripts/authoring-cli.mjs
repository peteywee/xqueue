import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { loadLibrary } from '../src/parse.mjs';
import { validateArtifactForReview } from '../src/authoring/authoring-validator.mjs';
import { withCandidateValidation } from '../src/authoring/candidate.mjs';
import { generateBoundedCandidates } from '../src/authoring/generation-provider.mjs';
import { runDeterministicAuthoring } from '../src/authoring/pipeline.mjs';
import { createOpenAIAuthoringProvider } from '../src/authoring/providers/openai.mjs';
import { createOwnerReviewPacket } from '../src/authoring/review.mjs';
import { planNonPostPromotion } from '../src/authoring/promotion.mjs';
import { planStateBoundPostPromotion } from '../src/authoring/promotion-state.mjs';
import { createGenerationTelemetry } from '../src/authoring/telemetry.mjs';
import {
  createExplicitOwnerApproval,
  readAuthoringJson,
  saveApproval,
  saveAuthoringRun,
  savePromotionPlan,
  saveReviewPacket,
  saveTelemetryEvent,
} from '../src/authoring/workspace.mjs';

const POST_TARGETS = Object.freeze({
  A: 'content/20-pillar-a.md',
  B: 'content/30-pillar-b.md',
  C: 'content/40-pillar-c.md',
  D: 'content/50-pillar-d.md',
});

function usage(message = null) {
  if (message) console.error(`ERROR: ${message}`);
  console.error(`
XQueue Author local workflow

  pnpm author:distill -- --input <file> --kind <post|blog|lesson> [options]
  pnpm author:generate -- --run <run.json> --unit-id <id> --kind <post|blog|lesson> --provider openai --live-generation [options]
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

Live generation options:
  --provider openai             currently the only live adapter
  --live-generation             mandatory explicit cost/network opt-in
  --candidate-count <1-5>       defaults to 3
  --model <model-id>            defaults to OPENAI_AUTHOR_MODEL or the adapter's cost-sensitive default
  --pillar <A|B|C|D>            required for post
  --workspace <path>            defaults to .xqueue-author

Promotion-plan never writes content/*.md. Post plans are bound to the exact target Markdown digest that existed when the plan was created.
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

function positiveIntFlag(flags, name, fallback, min, max) {
  if (flags[name] == null) return fallback;
  const value = Number(flags[name]);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function findCandidate(run, id) {
  const candidate = run?.candidates?.find((item) => item.candidate_id === id);
  if (!candidate) throw new Error(`candidate not found in run: ${id}`);
  return candidate;
}

function findKnowledgeUnit(run, id) {
  const unit = run?.knowledgeUnits?.find((item) => item.knowledge_unit_id === id);
  if (!unit) throw new Error(`knowledge unit not found in run: ${id}`);
  return unit;
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

async function generate(flags) {
  if (flags['live-generation'] !== true) {
    throw new Error('--live-generation is required before any paid/network generation call');
  }
  if (requireFlag(flags, 'provider') !== 'openai') {
    throw new Error('--provider must currently be openai');
  }

  const runPath = resolve(requireFlag(flags, 'run'));
  const run = await readAuthoringJson(runPath);
  const unit = findKnowledgeUnit(run, requireFlag(flags, 'unit-id'));
  const artifactKind = requireFlag(flags, 'kind');
  const pillar = flags.pillar || null;
  if (artifactKind === 'post' && !['A', 'B', 'C', 'D'].includes(pillar)) {
    throw new Error('--pillar A|B|C|D is required for post generation');
  }
  const candidateCount = positiveIntFlag(flags, 'candidate-count', 3, 1, 5);
  const createdAt = flags['created-at'] || new Date().toISOString();
  const libraryPosts = loadLibrary(join(process.cwd(), 'content'));
  const provider = createOpenAIAuthoringProvider({ model: typeof flags.model === 'string' ? flags.model : undefined });

  const started = Date.now();
  const generated = await generateBoundedCandidates(provider, {
    unit,
    artifactKind,
    pillar,
    candidateCount,
    createdAt,
  });
  const completedAt = new Date().toISOString();
  const validated = generated.map((candidate) => withCandidateValidation(candidate, validateArtifactForReview({
    candidate,
    knowledgeUnits: run.knowledgeUnits,
    sourceRecords: [run.source],
    libraryPosts,
    reviewedAt: completedAt,
  })));

  const updatedRun = {
    ...run,
    candidates: [...(Array.isArray(run.candidates) ? run.candidates : []), ...validated],
    last_generation_at: completedAt,
  };
  const saved = await saveAuthoringRun(updatedRun, { root: flags.workspace });

  const providerUsage = provider.getLastUsage() || {};
  const telemetry = createGenerationTelemetry({
    candidates: validated,
    usage: { ...providerUsage, latencyMs: Date.now() - started },
    completedAt,
  });
  const telemetryPath = await saveTelemetryEvent(telemetry, { root: flags.workspace });

  console.log(JSON.stringify({
    status: 'generated',
    run_id: saved.runId,
    path: saved.path,
    telemetry_path: telemetryPath,
    candidates: validated.map((candidate) => ({
      id: candidate.candidate_id,
      digest: candidate.content_digest,
      status: candidate.status,
      validation: candidate.validation.result,
    })),
    usage: telemetry.usage,
  }, null, 2));
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

  let plan;
  if (candidate.artifact_kind === 'post') {
    const targetPath = POST_TARGETS[candidate.pillar];
    if (!targetPath) throw new Error(`no post target configured for pillar ${candidate.pillar}`);
    const targetMarkdown = await readFile(join(process.cwd(), targetPath), 'utf8');
    plan = planStateBoundPostPromotion({
      candidate,
      approval,
      existingPosts: libraryPosts,
      targetMarkdown,
      promotedAt,
    });
  } else {
    plan = planNonPostPromotion({ candidate, approval, promotedAt });
  }

  const path = await savePromotionPlan(plan, { root: flags.workspace });
  console.log(JSON.stringify({
    status: 'planned',
    path,
    promotion_status: plan.status,
    destination: plan.targetPath || plan.destination,
    artifact_ref: plan.postId || plan.artifactRef,
    target_base_digest: plan.targetBaseDigest ?? null,
  }, null, 2));
}

const [command, ...tokens] = process.argv.slice(2);
if (!command) {
  usage();
} else {
  try {
    const flags = parseFlags(tokens);
    if (command === 'distill') await distill(flags);
    else if (command === 'generate') await generate(flags);
    else if (command === 'review') await review(flags);
    else if (command === 'approve') await approve(flags);
    else if (command === 'promotion-plan') await promotionPlan(flags);
    else usage(`unknown command: ${command}`);
  } catch (error) {
    console.error(`ERROR: ${error?.code ? `${error.code}: ` : ''}${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
