#!/usr/bin/env node

import { ProductionControlSession } from '../src/production-control-client.mjs';
import { readProductionMutationGuard } from './production-mutation-preflight.mjs';

const args = process.argv.slice(2);

function opt(name, fallback = null) {
  const exact = '--' + name;
  const index = args.indexOf(exact);
  if (index >= 0 && args[index + 1] !== undefined) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(exact + '='));
  return inline ? inline.slice(exact.length + 1) : fallback;
}

async function main() {
  const guard = readProductionMutationGuard({
    expectedHaltGeneration: opt('expected-halt-generation'),
  });

  const session = new ProductionControlSession({ expected: guard });
  await session.start();
  try {
    const results = await session.batch('production-control-proof', [
      "SELECT halted,generation,actor_class FROM publication_halt_state WHERE singleton_id=1",
      "SELECT owner,generation,transition_state,candidate_sha,deployment_id FROM authority_state WHERE singleton_id=1",
      "SELECT generation,revision_digest FROM queue_runtime_revisions ORDER BY generation DESC LIMIT 1",
    ]);

    const halt = results?.[0]?.results?.[0] ?? null;
    const authority = results?.[1]?.results?.[0] ?? null;
    const runtime = results?.[2]?.results?.[0] ?? null;

    if (
      Number(halt?.halted) !== 1 ||
      Number(halt?.generation) !== guard.haltGeneration ||
      halt?.actor_class !== 'owner'
    ) {
      throw new Error('control proof halt readback does not match production guard');
    }
    if (
      authority?.owner !== 'cloudflare' ||
      authority?.transition_state !== 'stable' ||
      String(authority?.candidate_sha ?? '').toLowerCase() !== guard.candidateSha ||
      authority?.deployment_id !== guard.deploymentId
    ) {
      throw new Error('control proof authority readback does not match production guard');
    }
    if (!runtime?.revision_digest || !Number.isSafeInteger(Number(runtime?.generation))) {
      throw new Error('control proof runtime revision readback is missing');
    }

    console.log(JSON.stringify({
      ok: true,
      publicationCapable: false,
      mutationPerformed: false,
      haltGeneration: guard.haltGeneration,
      candidateSha: guard.candidateSha,
      deploymentId: guard.deploymentId,
      authorityGeneration: guard.authorityGeneration,
      runtimeGeneration: Number(runtime.generation),
      runtimeRevisionDigest: runtime.revision_digest,
    }, null, 2));
  } finally {
    await session.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
