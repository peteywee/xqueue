import { Client, OAuth1 } from '@xdevplatform/xdk';

import {
  probeReadOnlyIdentity,
  readXBindings,
} from '../../probes/cloudflare-x/identity-contract.mjs';
import {
  createPostViaClient,
  uploadMediaBytesViaClient,
} from '../../probes/cloudflare-x/transport.mjs';
import {
  classifyPublicationOutcome,
} from '../../probes/cloudflare-x/outcome-classifier.mjs';
import {
  simulatePublicationTransaction,
} from '../../probes/cloudflare-x/simulation-harness.mjs';
import { COST } from '../../src/cost-model.mjs';

import {
  publicationAuthorityEnabled,
} from './authority-config.mjs';
import {
  publicationHaltVerdict,
  readGlobalPublicationHalt,
} from './publication-halt.mjs';
import {
  inspectAuthorityOwnership,
} from './authority-ownership-read.mjs';
import {
  readCurrentAssignmentHandle,
} from './assignment-version-fence.mjs';
import {
  evaluateEligibility,
} from './eligibility.mjs';
import {
  verifyMediaObjects,
} from './media-verify.mjs';
import {
  acquirePublicationLease,
  createPublicationLeaseIdentity,
  releasePublicationLease,
} from './publication-lease.mjs';
import {
  verifyPublicationLease,
} from './publication-lease-verify.mjs';
import {
  beginPublishingFence,
  persistPublicationOutcome,
  readPublicationSnapshot,
} from './publication-ledger.mjs';
import {
  decodeBundledQueue,
  verifyQueueIntegrity,
} from './queue-integrity.mjs';
import {
  MEDIA_MANIFEST,
  MEDIA_MANIFEST_CONFIGURED,
} from '../generated/media-manifest.mjs';

const EXPECTED_USERNAME = 'PatrickCra94338';
const LEASE_TTL_MS = 5 * 60 * 1000;

const DISCLAIMER =
  'General information, not legal advice. Wage and hour rules vary by\n' +
  'state — talk to an employment attorney about your situation.';

const URL_RE = /(?:https?:\/\/|www\.)/i;

function renderPost(post) {
  if (typeof post?.body !== 'string' || post.body.length === 0) {
    throw new Error('selected post has no body');
  }
  return post.pillar === 'B'
    ? `${post.body}\n\n${DISCLAIMER}`
    : post.body;
}

function publicationCost(post) {
  return URL_RE.test(post.body) ? COST.postWithUrl : COST.post;
}

function selectedPost(queue, eligibility) {
  const selected = eligibility?.selection?.selected;
  if (!eligibility?.safeToPublish || !Array.isArray(selected) || selected.length !== 1) {
    return null;
  }

  const matches = queue.filter((post) => post?.id === selected[0]);
  return matches.length === 1 ? matches[0] : null;
}

function makeClient(env) {
  const bindings = readXBindings(env);
  const oauth1 = new OAuth1({
    apiKey: bindings.X_API_KEY,
    apiSecret: bindings.X_API_SECRET,
    accessToken: bindings.X_ACCESS_TOKEN,
    accessTokenSecret: bindings.X_ACCESS_SECRET,
  });
  return new Client({ oauth1 });
}

function errorStatus(error) {
  const raw =
    error?.status ??
    error?.statusCode ??
    error?.response?.status ??
    error?.response?.statusCode;
  const status = Number(raw);
  return Number.isInteger(status) ? status : null;
}

function safeTransportError(error, phase, operation = null) {
  const wrapped = new Error('X transport operation failed');
  wrapped.phase = phase;
  if (operation) wrapped.operation = operation;

  const status = errorStatus(error);
  if (status !== null) wrapped.status = status;
  if (typeof error?.code === 'string') wrapped.code = error.code;

  return wrapped;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function prepareSelectedMedia(env, post) {
  if (post.figure === null || post.figure === undefined) {
    return {
      ok: true,
      required: false,
      bytes: null,
      mediaObject: null,
    };
  }

  if (MEDIA_MANIFEST_CONFIGURED !== true) {
    return { ok: false, reason: 'media_manifest_not_configured' };
  }

  const matches = MEDIA_MANIFEST.objects.filter(
    (object) => object.postId === post.id && object.figure === post.figure,
  );

  if (matches.length !== 1) {
    return { ok: false, reason: 'selected_media_manifest_mismatch' };
  }

  const manifestObject = matches[0];
  const verdict = await verifyMediaObjects(env, MEDIA_MANIFEST);
  const objectVerdict = verdict.objects?.find(
    (object) => object.r2Key === manifestObject.r2Key,
  );

  if (!verdict.ok || !objectVerdict?.ok) {
    return {
      ok: false,
      reason: objectVerdict?.reason ?? verdict.reason ?? 'media_verification_failed',
    };
  }

  const object = await env.MEDIA.get(manifestObject.r2Key);
  if (!object || typeof object.arrayBuffer !== 'function') {
    return { ok: false, reason: 'media_body_missing' };
  }

  const buffer = await object.arrayBuffer();
  if (buffer.byteLength !== manifestObject.byteSize) {
    return { ok: false, reason: 'media_body_size_mismatch' };
  }

  const hash = await sha256Hex(buffer);
  if (hash !== manifestObject.sha256) {
    return { ok: false, reason: 'media_body_hash_mismatch' };
  }

  return {
    ok: true,
    required: true,
    bytes: new Uint8Array(buffer),
    mediaObject: manifestObject,
  };
}

function idle(reason, extra = {}) {
  return Object.freeze({
    status: 'idle',
    reason,
    dispatched: false,
    automaticRetryAllowed: false,
    ...extra,
  });
}

async function currentHaltVerdict(readHalt, db) {
  try {
    return publicationHaltVerdict(await readHalt(db));
  } catch {
    return Object.freeze({
      ok: false,
      reason: 'halt_store_unavailable',
      halt: null,
    });
  }
}

function haltTransportError(verdict) {
  const error = new Error(verdict?.reason ?? 'publication_halt_unavailable');
  error.code =
    verdict?.reason === 'publication_halted'
      ? 'PUBLICATION_HALTED'
      : 'PUBLICATION_HALT_UNAVAILABLE';
  return safeTransportError(error, 'pre_dispatch');
}

export async function runScheduledPublication(
  env,
  {
    now = new Date(),
    dependencies = {},
  } = {},
) {
  if (!publicationAuthorityEnabled(env)) {
    return idle('authority_disabled');
  }

  if (Object.prototype.toString.call(now) !== '[object Date]' || !Number.isFinite(now.getTime())) {
    return idle('invalid_now');
  }

  const verifyQueue = dependencies.verifyQueueIntegrity ?? verifyQueueIntegrity;
  const readSnapshot = dependencies.readPublicationSnapshot ?? readPublicationSnapshot;
  const evaluate = dependencies.evaluateEligibility ?? evaluateEligibility;
  const decodeQueue = dependencies.decodeBundledQueue ?? decodeBundledQueue;
  const prepareMedia = dependencies.prepareSelectedMedia ?? prepareSelectedMedia;
  const createClient = dependencies.makeClient ?? makeClient;
  const simulate = dependencies.simulatePublicationTransaction ?? simulatePublicationTransaction;
  const beginFence = dependencies.beginPublishingFence ?? beginPublishingFence;
  const persistOutcome = dependencies.persistPublicationOutcome ?? persistPublicationOutcome;
  const acquireLease = dependencies.acquirePublicationLease ?? acquirePublicationLease;
  const releaseLease = dependencies.releasePublicationLease ?? releasePublicationLease;
  const verifyLease = dependencies.verifyPublicationLease ?? verifyPublicationLease;
  const readAssignment =
    dependencies.readCurrentAssignmentHandle ?? readCurrentAssignmentHandle;
  const readHalt =
    dependencies.readGlobalPublicationHalt ?? readGlobalPublicationHalt;
  const inspectOwnership =
    dependencies.inspectAuthorityOwnership ?? inspectAuthorityOwnership;

  const initialHalt = await currentHaltVerdict(readHalt, env.DB);
  if (!initialHalt.ok) {
    return idle(initialHalt.reason, { halt: initialHalt.halt });
  }

  let durableAuthority;
  try {
    durableAuthority = await inspectOwnership(env.DB);
  } catch {
    return idle('durable_authority_unavailable');
  }

  if (
    durableAuthority?.ok !== true ||
    durableAuthority?.state?.owner !== 'cloudflare' ||
    durableAuthority?.state?.transition_state !== 'stable'
  ) {
    return idle('durable_authority_not_cloudflare', {
      authority: {
        ok: durableAuthority?.ok === true,
        reason: durableAuthority?.reason ?? null,
        owner: durableAuthority?.state?.owner ?? null,
        generation: durableAuthority?.state?.generation ?? null,
        transitionState: durableAuthority?.state?.transition_state ?? null,
      },
    });
  }

  const queueIntegrity = await verifyQueue(env);
  if (!queueIntegrity?.ok) {
    return idle('queue_integrity_failed', { queueIntegrity });
  }

  let queue;
  let sourceSnapshot;
  try {
    queue = decodeQueue();
    sourceSnapshot = await readSnapshot(env.DB);
  } catch {
    return idle('runtime_state_unavailable');
  }

  const eligibilityOptions = {
    now,
    graceMinutes: 20,
    maxPublications: 1,
  };

  const eligibility = evaluate(queue, sourceSnapshot.ledger, eligibilityOptions);
  const post = selectedPost(queue, eligibility);

  if (!post) {
    return idle(
      eligibility?.selection?.blockReason ??
        eligibility?.failures?.[0] ??
        'nothing_due',
      { eligibility },
    );
  }

  let assignmentHandle;
  try {
    assignmentHandle = await readAssignment(env.DB, post.id);
  } catch {
    return idle('assignment_identity_unavailable');
  }

  const preparedMedia = await prepareMedia(env, post);
  if (!preparedMedia?.ok) {
    return idle(preparedMedia?.reason ?? 'media_not_ready');
  }

  const text = renderPost(post);
  const cost = publicationCost(post);

  let client = null;
  let publishingSnapshot = null;
  let activeLease = null;

  const result = await simulate(
    {
      verifyIdentity: async () => {
        client ??= createClient(env);
        return probeReadOnlyIdentity({
          getMe: () => client.users.getMe(),
          expected: { username: EXPECTED_USERNAME },
        });
      },

      evaluateEligibility: evaluate,

      acquireLease: async () => {
        const halt = await currentHaltVerdict(readHalt, env.DB);
        if (!halt.ok) {
          return {
            acquired: false,
            reason: halt.reason,
            halt: halt.halt,
          };
        }

        const identity = createPublicationLeaseIdentity();
        const acquired = await acquireLease(env.DB, {
          ...identity,
          ttlMs: LEASE_TTL_MS,
          nowMs: Date.now(),
        });
        activeLease = acquired?.acquired ? acquired.lease : null;
        return acquired;
      },

      verifyLease: async (lease) =>
        verifyLease(env.DB, lease, { nowMs: Date.now() }),

      releaseLease: async (lease) =>
        releaseLease(env.DB, lease, { nowMs: Date.now() }),

      verifyMedia: async ({ post: selected }) =>
        selected?.id === post.id
          ? preparedMedia
          : { ok: false, reason: 'selected_post_changed' },

      dispatchPost: async ({ post: selected, media }) => {
        try {
          publishingSnapshot = await beginFence(
            env.DB,
            sourceSnapshot,
            {
              post: selected,
              text,
              cost,
              now: new Date(),
              lease: activeLease,
              assignment: assignmentHandle,
            },
          );
        } catch (error) {
          throw safeTransportError(error, 'pre_dispatch');
        }

        const mediaIds = [];

        if (media.required) {
          const haltBeforeMedia = await currentHaltVerdict(readHalt, env.DB);
          if (!haltBeforeMedia.ok) {
            throw haltTransportError(haltBeforeMedia);
          }

          try {
            client ??= createClient(env);
            const mediaId = await uploadMediaBytesViaClient(client, media.bytes);
            mediaIds.push(mediaId);
          } catch (error) {
            throw safeTransportError(error, 'pre_dispatch', 'media_upload');
          }

          const leaseStillCurrent = activeLease
            ? await verifyLease(env.DB, activeLease, { nowMs: Date.now() }).catch(() => false)
            : false;

          if (!leaseStillCurrent) {
            const error = new Error('lease fenced after media upload');
            error.code = 'LEASE_FENCED_AFTER_MEDIA';
            throw safeTransportError(error, 'pre_dispatch');
          }
        }

        const haltBeforePost = await currentHaltVerdict(readHalt, env.DB);
        if (!haltBeforePost.ok) {
          throw haltTransportError(haltBeforePost);
        }

        try {
          client ??= createClient(env);
          const response = await createPostViaClient(client, {
            text,
            mediaIds,
          });

          return {
            status: 200,
            data: response?.data,
          };
        } catch (error) {
          throw safeTransportError(error, 'dispatched');
        }
      },

      classifyOutcome: classifyPublicationOutcome,

      recordEvidence: async (evidence) => {
        if (!publishingSnapshot) {
          throw new Error('publishing fence was not persisted');
        }

        await persistOutcome(
          env.DB,
          publishingSnapshot,
          {
            post,
            outcome: evidence.outcome,
            now: new Date(),
          },
        );
      },
    },
    {
      queue,
      ledger: sourceSnapshot.ledger,
      eligibilityOptions,
    },
  );

  return Object.freeze({
    ...result,
    selectedPostId: post.id,
  });
}

export const productionPublisherInternals = Object.freeze({
  renderPost,
  publicationCost,
  prepareSelectedMedia,
});
