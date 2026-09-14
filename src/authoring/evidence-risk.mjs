import {
  AuthoringContractError,
  assertArtifactCandidate,
  assertKnowledgeUnit,
  assertSourceRecord,
} from './contracts.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

function asTime(value, name) {
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    throw new AuthoringContractError('invalid_risk_time', `${name} must be an ISO-compatible date-time`);
  }
  return time;
}

export function assessEvidenceRisk({
  candidate,
  knowledgeUnits,
  sourceRecords,
  now,
  currentFactMaxAgeDays = 30,
}) {
  assertArtifactCandidate(candidate);
  if (!Array.isArray(knowledgeUnits) || !Array.isArray(sourceRecords)) {
    throw new AuthoringContractError('invalid_risk_context', 'knowledgeUnits and sourceRecords must be arrays');
  }
  if (!Number.isInteger(currentFactMaxAgeDays) || currentFactMaxAgeDays < 1 || currentFactMaxAgeDays > 3650) {
    throw new AuthoringContractError('invalid_freshness_window', 'currentFactMaxAgeDays must be an integer from 1 to 3650');
  }

  const nowMs = asTime(now, 'now');
  const unitMap = new Map(knowledgeUnits.map((unit) => [unit.knowledge_unit_id, unit]));
  const sourceMap = new Map(sourceRecords.map((source) => [source.source_id, source]));
  const findings = [];

  for (const unitRef of candidate.knowledge_unit_refs) {
    const unit = unitMap.get(unitRef);
    if (!unit) continue;
    assertKnowledgeUnit(unit);

    for (const sourceRef of unit.source_refs) {
      if (!candidate.source_refs.includes(sourceRef)) {
        findings.push({
          level: 'error',
          rule: 'provenance-gap',
          message: `${unitRef} depends on ${sourceRef}, but the candidate does not carry that source reference`,
        });
      }
    }

    if (unit.support_state !== 'supported') {
      findings.push({
        level: 'error',
        rule: 'unresolved-support-state',
        message: `${unitRef} is ${unit.support_state}`,
      });
    }

    if (unit.claim_class === 'current_factual') {
      const supporting = unit.source_refs
        .map((ref) => sourceMap.get(ref))
        .filter(Boolean)
        .filter((source) => ['authoritative_reference', 'evidence'].includes(source.trust_class));

      if (!supporting.length) {
        findings.push({
          level: 'error',
          rule: 'current-fact-evidence-required',
          message: `${unitRef} is current-factual but has no authoritative/evidence source`,
        });
      } else {
        for (const source of supporting) assertSourceRecord(source);
        const freshest = Math.max(...supporting.map((source) => asTime(source.observed_at, 'source observed_at')));
        const ageDays = (nowMs - freshest) / DAY_MS;
        if (ageDays < 0) {
          findings.push({
            level: 'error',
            rule: 'future-dated-source',
            message: `${unitRef} relies on evidence observed after the review time`,
          });
        } else if (ageDays > currentFactMaxAgeDays) {
          findings.push({
            level: 'error',
            rule: 'current-fact-stale',
            message: `${unitRef} freshest evidence is ${Math.floor(ageDays)} days old`,
          });
        }
      }
    }

    if (unit.claim_class === 'generated_assertion') {
      const independentlySupported = unit.source_refs
        .map((ref) => sourceMap.get(ref))
        .filter(Boolean)
        .some((source) => ['owner_attested', 'authoritative_reference', 'evidence'].includes(source.trust_class));
      if (!independentlySupported) {
        findings.push({
          level: 'error',
          rule: 'generated-assertion-unverified',
          message: `${unitRef} originates from generated/unverified material without independent support`,
        });
      }
    }

    if (['sensitive', 'restricted'].includes(unit.sensitivity)) {
      findings.push({
        level: 'error',
        rule: 'knowledge-unit-publication-restricted',
        message: `${unitRef} sensitivity ${unit.sensitivity} blocks publication`,
      });
    }
  }

  for (const sourceRef of candidate.source_refs) {
    const source = sourceMap.get(sourceRef);
    if (!source) continue;
    assertSourceRecord(source);
    if (source.sensitivity === 'restricted') {
      findings.push({ level: 'error', rule: 'restricted-source', message: `${sourceRef} is restricted` });
    } else if (source.sensitivity === 'sensitive') {
      findings.push({
        level: 'error',
        rule: 'sensitive-source-redaction-required',
        message: `${sourceRef} is sensitive and requires an explicit redacted/derived source before publication`,
      });
    }
  }

  return findings;
}
