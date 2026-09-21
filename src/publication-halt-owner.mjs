function requiredReason(value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('reason is required');
  }
  return value.trim();
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(label + ' must be a positive integer');
  }
  return number;
}

function canonicalIso(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error('at must be an ISO timestamp');
  return new Date(ms).toISOString();
}

function sqlText(value) {
  return "'" + String(value).replaceAll("'", "''") + "'";
}

export function renderOwnerClearPublicationHaltSql({
  expectedGeneration,
  reason,
  at = new Date().toISOString(),
}) {
  const generation = positiveInteger(expectedGeneration, 'expectedGeneration');
  const normalizedReason = requiredReason(reason);
  const timestamp = canonicalIso(at);

  return [
    'UPDATE publication_halt_state',
    'SET halted = 0,',
    '    generation = generation + 1,',
    '    reason = ' + sqlText(normalizedReason) + ',',
    "    actor_class = 'owner',",
    '    updated_at = ' + sqlText(timestamp),
    'WHERE singleton_id = 1',
    '  AND halted = 1',
    '  AND generation = ' + generation + ';',
    'SELECT changes() AS direct_changes;',
    'SELECT singleton_id, halted, generation, reason, actor_class, updated_at',
    'FROM publication_halt_state',
    'WHERE singleton_id = 1;',
  ].join('\n');
}

export function renderPublicationHaltStatusSql() {
  return [
    'SELECT singleton_id, halted, generation, reason, actor_class, updated_at',
    'FROM publication_halt_state',
    'WHERE singleton_id = 1;',
  ].join('\n');
}
