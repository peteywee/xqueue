import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { loadLibrary } from '../src/parse.mjs';
import {
  createAuthenticatedOwnerApproval,
  createOwnerApprovalPayload,
  ownerPublicKeyFingerprint,
  parseCanonicalOwnerApprovalPayload,
  serializeOwnerApprovalPayload,
} from '../src/authoring/owner-approval.mjs';
import { planNonPostPromotion } from '../src/authoring/promotion.mjs';
import { planStateBoundPostPromotion } from '../src/authoring/promotion-state.mjs';
import {
  readAuthoringJson,
  saveApproval,
  savePromotionPlan,
} from '../src/authoring/workspace.mjs';

const OWNER_PUBLIC_KEY_PATH = join(process.cwd(), 'authoring', 'owner', 'approval-public-key.pem');

const POST_TARGETS = Object.freeze({
  A: 'content/20-pillar-a.md',
  B: 'content/30-pillar-b.md',
  C: 'content/40-pillar-c.md',
  D: 'content/50-pillar-d.md',
});

function usage(message = null) {
  if (message) console.error(`ERROR: ${message}`);
  console.error(`
XQueue owner approval workflow

  pnpm author:approval-payload -- --run <run.json> --candidate-id <id> --decision <approve|reject> --output <payload.json> [--decided-at <ISO>]
  pnpm author:approve -- --run <run.json> --candidate-id <id> --payload <payload.json> --signature <signature.bin> [--attestation <text>] [--notes <text>]
  pnpm author:promotion-plan -- --run <run.json> --candidate-id <id> --approval <approval.json>

Authority rules:
  - payload preparation is non-authoritative;
  - the owner signs the exact payload bytes outside XQueue automation;
  - only authoring/owner/approval-public-key.pem is trusted for verification;
  - the private signing key must never enter the repository, CI, .xqueue-author, telemetry, or generation providers;
  - promotion re-verifies the detached Ed25519 signature every time.
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

async function readOwnerPublicKey() {
  try {
    return await readFile(OWNER_PUBLIC_KEY_PATH, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`owner approval public key is not configured at ${OWNER_PUBLIC_KEY_PATH}`);
    }
    throw error;
  }
}

async function payload(flags) {
  const run = await readAuthoringJson(resolve(requireFlag(flags, 'run')));
  const candidate = findCandidate(run, requireFlag(flags, 'candidate-id'));
  const decision = requireFlag(flags, 'decision');
  const decidedAt = typeof flags['decided-at'] === 'string' ? flags['decided-at'] : new Date().toISOString();
  const outputPath = resolve(requireFlag(flags, 'output'));
  const value = createOwnerApprovalPayload({ candidate, decision, decidedAt });
  const text = serializeOwnerApprovalPayload(value);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, text, { encoding: 'utf8', flag: 'wx' });
  console.log(JSON.stringify({
    status: 'payload_prepared_non_authoritative',
    path: outputPath,
    candidate_id: value.candidate_id,
    candidate_digest: value.candidate_digest,
    decision: value.decision,
    decided_at: value.decided_at,
    next: 'Sign the exact payload bytes with the owner-held Ed25519 private key, then import the detached signature with author:approve.',
  }, null, 2));
}

async function approve(flags) {
  const run = await readAuthoringJson(resolve(requireFlag(flags, 'run')));
  const candidate = findCandidate(run, requireFlag(flags, 'candidate-id'));
  const payloadText = await readFile(resolve(requireFlag(flags, 'payload')), 'utf8');
  const signedPayload = parseCanonicalOwnerApprovalPayload(payloadText);
  const signatureBytes = await readFile(resolve(requireFlag(flags, 'signature')));
  const publicKeyPem = await readOwnerPublicKey();
  const approval = createAuthenticatedOwnerApproval({
    candidate,
    payload: signedPayload,
    signatureBase64: signatureBytes.toString('base64'),
    publicKeyPem,
    attestations: flags.attestation ? [String(flags.attestation)] : [],
    notes: typeof flags.notes === 'string' ? flags.notes : null,
  });
  const path = await saveApproval(approval, { root: flags.workspace });
  console.log(JSON.stringify({
    status: 'owner_signature_verified',
    path,
    approval_id: approval.approval_id,
    decision: approval.decision,
    candidate_digest: approval.candidate_digest,
    public_key_fingerprint: approval.owner_proof.public_key_fingerprint,
  }, null, 2));
}

async function promotionPlan(flags) {
  const run = await readAuthoringJson(resolve(requireFlag(flags, 'run')));
  const candidate = findCandidate(run, requireFlag(flags, 'candidate-id'));
  const approval = await readAuthoringJson(resolve(requireFlag(flags, 'approval')));
  const publicKeyPem = await readOwnerPublicKey();
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
      ownerPublicKeyPem: publicKeyPem,
      existingPosts: libraryPosts,
      targetMarkdown,
      promotedAt,
    });
  } else {
    plan = planNonPostPromotion({
      candidate,
      approval,
      ownerPublicKeyPem: publicKeyPem,
      promotedAt,
    });
  }

  const path = await savePromotionPlan(plan, { root: flags.workspace });
  console.log(JSON.stringify({
    status: 'planned_after_owner_signature_reverification',
    path,
    promotion_status: plan.status,
    destination: plan.targetPath || plan.destination,
    artifact_ref: plan.postId || plan.artifactRef,
    target_base_digest: plan.targetBaseDigest ?? null,
    owner_public_key_fingerprint: ownerPublicKeyFingerprint(publicKeyPem),
  }, null, 2));
}

const [command, ...tokens] = process.argv.slice(2);
if (!command) {
  usage();
} else {
  try {
    const flags = parseFlags(tokens);
    if (command === 'payload') await payload(flags);
    else if (command === 'approve') await approve(flags);
    else if (command === 'promotion-plan') await promotionPlan(flags);
    else usage(`unknown command: ${command}`);
  } catch (error) {
    console.error(`ERROR: ${error?.code ? `${error.code}: ` : ''}${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
