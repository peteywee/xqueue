const ACCOUNT_TOKEN_PREFIX = 'cfat_';
const USER_TOKEN_PREFIX = 'cfut_';

function requireNonEmpty(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(name + ' is required');
  }
  return value;
}

export function classifyCloudflareApiToken(token) {
  requireNonEmpty(token, 'CLOUDFLARE_API_TOKEN');

  if (token !== token.trim() || /\s/.test(token)) {
    throw new Error(
      'CLOUDFLARE_API_TOKEN contains whitespace; paste only the raw token secret',
    );
  }

  if (token.startsWith(ACCOUNT_TOKEN_PREFIX)) return 'account';
  if (token.startsWith(USER_TOKEN_PREFIX)) return 'user';

  throw new Error(
    'unsupported Cloudflare API token format; expected a prefixed cfat_ account token or cfut_ user token',
  );
}

export function cloudflareTokenVerifyUrl({ token, accountId }) {
  const tokenType = classifyCloudflareApiToken(token);

  if (tokenType === 'account') {
    if (typeof accountId !== 'string' || !/^[0-9a-f]{32}$/i.test(accountId)) {
      throw new Error(
        'CLOUDFLARE_ACCOUNT_ID must be a 32-character account ID for cfat_ account-token verification',
      );
    }
    return {
      tokenType,
      url:
        'https://api.cloudflare.com/client/v4/accounts/' +
        accountId +
        '/tokens/verify',
    };
  }

  return {
    tokenType,
    url: 'https://api.cloudflare.com/client/v4/user/tokens/verify',
  };
}

function renderErrorCodes(payload) {
  const errors = Array.isArray(payload?.errors) ? payload.errors : [];
  if (errors.length === 0) return 'no API error code returned';

  return errors
    .map((item) => (item?.code == null ? 'unknown' : String(item.code)))
    .join(',');
}

export async function verifyCloudflareApiToken({
  token = process.env.CLOUDFLARE_API_TOKEN,
  accountId = process.env.CLOUDFLARE_ACCOUNT_ID,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Cloudflare token verification requires fetch support');
  }

  const { tokenType, url } = cloudflareTokenVerifyUrl({ token, accountId });

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/json',
      },
    });
  } catch (error) {
    throw new Error(
      'Cloudflare ' +
        tokenType +
        ' API token verification request failed: ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(
      'Cloudflare ' + tokenType + ' API token verification returned non-JSON',
    );
  }

  if (
    response.ok !== true ||
    payload?.success !== true ||
    payload?.result?.status !== 'active'
  ) {
    throw new Error(
      'Cloudflare ' +
        tokenType +
        ' API token verification failed (' +
        renderErrorCodes(payload) +
        ')',
    );
  }

  return Object.freeze({
    ok: true,
    tokenType,
    status: payload.result.status,
    expiresOn:
      typeof payload.result.expires_on === 'string'
        ? payload.result.expires_on
        : null,
    verifyUrl: url,
  });
}
