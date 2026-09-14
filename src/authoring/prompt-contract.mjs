import { AuthoringContractError, digestObject } from './contracts.mjs';

const PROMPT_CONTRACTS = Object.freeze({
  'author-v1': Object.freeze({
    version: 'author-v1',
    purpose: 'Transform one supported knowledge unit into bounded draft candidates for owner review.',
    authority: 'draft_only',
    outputs: Object.freeze(['post', 'blog', 'lesson']),
    rules: Object.freeze([
      'Use only the supplied knowledge unit and referenced evidence context.',
      'Do not invent first-person experience, customers, deployments, metrics, revenue, employers, or outcomes.',
      'Do not claim approval, publication, scheduling, authority, or promotion state.',
      'Preserve failure history when the source knowledge is a lesson or failure.',
      'Return draft text only; downstream validation and owner approval are mandatory.',
    ]),
  }),
});

export function getPromptContract(version = 'author-v1') {
  if (typeof version !== 'string' || !version.trim()) {
    throw new AuthoringContractError('prompt_version_required', 'prompt version is required');
  }
  const contract = PROMPT_CONTRACTS[version];
  if (!contract) {
    throw new AuthoringContractError('unsupported_prompt_version', `unsupported prompt version: ${version}`);
  }
  return contract;
}

export function promptContractDigest(version = 'author-v1') {
  return digestObject(getPromptContract(version));
}

export function listPromptVersions() {
  return Object.freeze(Object.keys(PROMPT_CONTRACTS));
}
