export const X_BINDING_NAMES = Object.freeze([
  'X_API_KEY',
  'X_API_SECRET',
  'X_ACCESS_TOKEN',
  'X_ACCESS_SECRET',
]);

function fail(message) {
  const error = new Error(message);
  error.name = 'XIdentityContractError';
  throw error;
}

function readBindingValue(env, name) {
  try {
    return env?.[name];
  } catch {
    fail(`Unable to read X binding: ${name}`);
  }
}

export function readXBindings(env = {}) {
  const values = new Map();
  const missing = [];

  for (const name of X_BINDING_NAMES) {
    const value = readBindingValue(env, name);
    if (typeof value !== 'string' || value.length === 0) missing.push(name);
    else values.set(name, value);
  }

  if (missing.length) {
    fail(`Missing required X binding(s): ${missing.join(', ')}`);
  }

  return Object.freeze(Object.fromEntries(
    X_BINDING_NAMES.map((name) => [name, values.get(name)]),
  ));
}

export function sanitizeIdentityEvidence(response) {
  const data = response?.data;
  if (!data || typeof data !== 'object') fail('X identity response has no data object');

  const id = data.id === undefined || data.id === null ? null : String(data.id);
  const username = typeof data.username === 'string' ? data.username : null;

  if (!id || !username) fail('X identity response is missing id or username');

  return Object.freeze({ id, username });
}

export function assertExpectedIdentity(identity, expected = {}) {
  const expectedId = expected.id === undefined || expected.id === null
    ? null
    : String(expected.id);
  const expectedUsername = typeof expected.username === 'string'
    ? expected.username
    : null;

  if (!expectedId && !expectedUsername) {
    fail('Expected X identity must include id and/or username');
  }

  if (expectedId && identity.id !== expectedId) {
    fail('X identity ID mismatch');
  }
  if (expectedUsername && identity.username.toLowerCase() !== expectedUsername.toLowerCase()) {
    fail('X identity username mismatch');
  }

  return identity;
}

export async function probeReadOnlyIdentity({ getMe, expected }) {
  if (typeof getMe !== 'function') fail('Read-only identity probe requires getMe');

  let response;
  try {
    response = await getMe();
  } catch {
    fail('X identity probe failed');
  }

  const identity = sanitizeIdentityEvidence(response);
  return assertExpectedIdentity(identity, expected);
}
