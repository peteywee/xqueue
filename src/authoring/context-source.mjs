import { assertSourceRecord, AuthoringContractError } from './contracts.mjs';

export function createContextSourceAdapter({ name, retrieve }) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new AuthoringContractError('invalid_adapter_name', 'context source adapter requires a non-empty name');
  }
  if (typeof retrieve !== 'function') {
    throw new AuthoringContractError('invalid_adapter_retrieve', 'context source adapter requires a retrieve function');
  }

  return Object.freeze({
    name,
    mode: 'read_only',
    async retrieve(query) {
      const result = await retrieve({ ...query, readOnly: true, requireProvenance: true });
      if (!Array.isArray(result)) {
        throw new AuthoringContractError('invalid_context_result', 'context source retrieve must return an array');
      }
      return result.map((record) => assertSourceRecord(record));
    },
  });
}

export async function retrieveContext(adapter, query = {}) {
  if (!adapter || adapter.mode !== 'read_only' || typeof adapter.retrieve !== 'function') {
    throw new AuthoringContractError('read_only_adapter_required', 'XQueue Author accepts only a read-only context source adapter');
  }

  const maxResults = query.maxResults ?? 20;
  if (!Number.isInteger(maxResults) || maxResults < 1 || maxResults > 50) {
    throw new AuthoringContractError('invalid_max_results', 'maxResults must be an integer from 1 to 50');
  }

  const normalized = {
    query: typeof query.query === 'string' ? query.query : '',
    projects: Array.isArray(query.projects) ? query.projects : [],
    sourceTypes: Array.isArray(query.sourceTypes) ? query.sourceTypes : [],
    maxResults,
    readOnly: true,
    requireProvenance: true,
  };

  return adapter.retrieve(normalized);
}
