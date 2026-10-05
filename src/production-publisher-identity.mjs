// Pure identity parsing for the production publisher's exact Worker version.
// It lives apart from the authority transfer SQL so that Worker code needing
// only the parser never imports authority or mirror write compilers.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEPLOYMENT_PREFIX =
  'cloudflare-worker:xqueue-publisher-production:version:';

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  if (value.includes('\0')) {
    throw new TypeError(`${name} must not contain NUL`);
  }
  return value.trim();
}

export function parseProductionPublisherDeploymentId(value, name = 'deploymentId') {
  const text = requireText(value, name);
  if (!text.startsWith(DEPLOYMENT_PREFIX)) {
    throw new TypeError(
      `${name} must identify xqueue-publisher-production exact Worker version`,
    );
  }
  const versionId = text.slice(DEPLOYMENT_PREFIX.length);
  if (!UUID_RE.test(versionId)) {
    throw new TypeError(
      `${name} must identify xqueue-publisher-production exact Worker version`,
    );
  }
  const normalizedVersionId = versionId.toLowerCase();
  return Object.freeze({
    deploymentId: DEPLOYMENT_PREFIX + normalizedVersionId,
    versionId: normalizedVersionId,
  });
}

export function productionPublisherDeploymentId(versionId) {
  const normalized = requireText(versionId, 'versionId').toLowerCase();
  if (!UUID_RE.test(normalized)) {
    throw new TypeError('versionId must be an exact Worker version UUID');
  }
  return DEPLOYMENT_PREFIX + normalized;
}
