function requireClientMethod(client, path) {
  let current = client;
  for (const part of path) current = current?.[part];
  if (typeof current !== 'function') {
    throw new TypeError(`X transport client is missing ${path.join('.')}`);
  }
  return current;
}

function normalizeId(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

export function buildPostBody({ text, mediaIds = [], replyTo = null } = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new TypeError('text must be a non-empty string');
  }
  if (!Array.isArray(mediaIds)) {
    throw new TypeError('mediaIds must be an array');
  }

  const body = { text };
  if (mediaIds.length) {
    body.media = { mediaIds: mediaIds.map((id) => normalizeId(id, 'media ID')) };
  }
  if (replyTo !== null) {
    body.reply = { inReplyToTweetId: normalizeId(replyTo, 'replyTo') };
  }
  return body;
}

export function bytesToBase64(value) {
  let bytes;
  if (value instanceof Uint8Array) bytes = value;
  else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else throw new TypeError('media bytes must be Uint8Array or ArrayBuffer');

  if (bytes.byteLength === 0) throw new TypeError('media bytes must not be empty');

  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function whoAmIViaClient(client) {
  const getMe = requireClientMethod(client, ['users', 'getMe']);
  return getMe.call(client.users);
}

export async function uploadMediaBytesViaClient(
  client,
  bytes,
  { mediaCategory = 'tweet_image' } = {},
) {
  const upload = requireClientMethod(client, ['media', 'upload']);
  const response = await upload.call(client.media, {
    media: bytesToBase64(bytes),
    mediaCategory,
  });

  const mediaId = response?.data?.id;
  if (mediaId === undefined || mediaId === null || String(mediaId).trim() === '') {
    throw new Error('X media upload returned no media ID');
  }
  return String(mediaId);
}

export async function createPostViaClient(client, input) {
  const create = requireClientMethod(client, ['posts', 'create']);
  return create.call(client.posts, buildPostBody(input));
}
