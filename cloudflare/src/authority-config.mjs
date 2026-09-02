export const XQUEUE_PUBLISH_AUTHORITY_VALUE = 'enabled';

export function publicationAuthorityEnabled(env = {}) {
  try {
    return env?.XQUEUE_PUBLISH_AUTHORITY === XQUEUE_PUBLISH_AUTHORITY_VALUE;
  } catch {
    return false;
  }
}
