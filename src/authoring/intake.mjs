import { AuthoringContractError, assertSourceRecord, digestText } from './contracts.mjs';

const DEFAULT_MAX_SEGMENT_CHARS = 1600;

function nonEmpty(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AuthoringContractError('invalid_source_input', `${name} must be a non-empty string`);
  }
  return value.trim();
}

export function normalizeSourceInput({
  sourceId,
  sourceType,
  trustClass,
  locator,
  observedAt,
  text,
  project = null,
  sensitivity = 'internal',
  metadata = {},
}) {
  const body = nonEmpty(text, 'text');
  const record = {
    source_id: nonEmpty(sourceId, 'sourceId'),
    source_type: nonEmpty(sourceType, 'sourceType'),
    trust_class: nonEmpty(trustClass, 'trustClass'),
    locator: nonEmpty(locator, 'locator'),
    observed_at: nonEmpty(observedAt, 'observedAt'),
    content_digest: digestText(body),
    project,
    sensitivity,
    metadata,
  };

  assertSourceRecord(record);
  return Object.freeze({ record: Object.freeze(record), text: body });
}

export function segmentSource(source, { maxChars = DEFAULT_MAX_SEGMENT_CHARS } = {}) {
  if (!source?.record || typeof source.text !== 'string') {
    throw new AuthoringContractError('invalid_normalized_source', 'segmentSource requires normalizeSourceInput output');
  }
  assertSourceRecord(source.record);
  if (!Number.isInteger(maxChars) || maxChars < 200 || maxChars > 10000) {
    throw new AuthoringContractError('invalid_segment_size', 'maxChars must be an integer from 200 to 10000');
  }

  const paragraphs = source.text
    .split(/\n\s*\n/g)
    .map((value) => value.trim())
    .filter(Boolean);

  const chunks = [];
  let current = '';

  function flush() {
    if (!current) return;
    chunks.push(current);
    current = '';
  }

  for (const paragraph of paragraphs) {
    if (paragraph.length > maxChars) {
      flush();
      for (let offset = 0; offset < paragraph.length; offset += maxChars) {
        chunks.push(paragraph.slice(offset, offset + maxChars));
      }
      continue;
    }

    const combined = current ? `${current}\n\n${paragraph}` : paragraph;
    if (combined.length > maxChars) {
      flush();
      current = paragraph;
    } else {
      current = combined;
    }
  }
  flush();

  if (!chunks.length) {
    throw new AuthoringContractError('empty_segments', 'normalized source produced no segments');
  }

  return chunks.map((text, index) => Object.freeze({
    segment_id: `${source.record.source_id}:seg:${String(index + 1).padStart(4, '0')}`,
    source_id: source.record.source_id,
    index,
    text,
    content_digest: digestText(text),
  }));
}
