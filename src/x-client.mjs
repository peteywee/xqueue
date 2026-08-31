// x-client.mjs — minimal X API v2 client. No dependencies; node:crypto only.
//
// OAuth 1.0a user-context signing is used deliberately over OAuth 2.0 PKCE:
// static credentials, no refresh dance, no browser round-trip. That matters
// for something a cron job runs unattended at 22:15.
//
// Costs at time of writing (pay-per-use, no free allowance):
//   post create ............ $0.015
//   post create WITH a URL .. $0.200   <- 13x. Keep links out of post bodies.
//   owned reads ............ $0.001 per resource
// Media upload billing is not separately documented; measure month one.

import { createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

const API = 'https://api.x.com';

export const COST = { post: 0.015, postWithUrl: 0.2, ownedRead: 0.001 };

const enc = (s) =>
  encodeURIComponent(String(s)).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function sign({ method, url, params, consumerSecret, tokenSecret }) {
  const base = [
    method.toUpperCase(),
    enc(url),
    enc(Object.keys(params).sort().map((k) => `${enc(k)}=${enc(params[k])}`).join('&')),
  ].join('&');
  const key = `${enc(consumerSecret)}&${enc(tokenSecret)}`;
  return createHmac('sha1', key).update(base).digest('base64');
}

function authHeader(creds, method, url, extraParams = {}) {
  const oauth = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
  };
  // Query params participate in the signature; a JSON or multipart body does not.
  const signature = sign({
    method,
    url,
    params: { ...oauth, ...extraParams },
    consumerSecret: creds.apiSecret,
    tokenSecret: creds.accessSecret,
  });
  const all = { ...oauth, oauth_signature: signature };
  return 'OAuth ' + Object.keys(all).sort().map((k) => `${enc(k)}="${enc(all[k])}"`).join(', ');
}

export function credsFromEnv(env = process.env) {
  const c = {
    apiKey: env.X_API_KEY,
    apiSecret: env.X_API_SECRET,
    accessToken: env.X_ACCESS_TOKEN,
    accessSecret: env.X_ACCESS_SECRET,
  };
  const missing = Object.entries(c).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    throw new Error(
      `Missing credentials: ${missing.join(', ')}. ` +
      'Create an app at developer.x.com with Read and Write permissions, ' +
      'generate an access token and secret, and put all four in .env',
    );
  }
  return c;
}

async function call(creds, method, path, { query = {}, json = null, form = null } = {}) {
  const url = `${API}${path}`;
  const qs = new URLSearchParams(query).toString();
  const headers = { Authorization: authHeader(creds, method, url, query) };
  let body;
  if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) { body = form; } // FormData sets its own content-type boundary

  const res = await fetch(qs ? `${url}?${qs}` : url, { method, headers, body });
  const text = await res.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }

  if (!res.ok) {
    const err = new Error(`X API ${res.status}: ${parsed?.detail ?? parsed?.title ?? text.slice(0, 300)}`);
    err.status = res.status;
    err.body = parsed;
    // 429 carries a reset; surface it so the caller can back off instead of hammering.
    err.resetAt = res.headers.get('x-rate-limit-reset');
    throw err;
  }
  return parsed;
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

/** Chunked upload: INIT -> APPEND -> FINALIZE. Returns media_id_string. */
export async function uploadMedia(creds, filePath) {
  const data = await readFile(filePath);
  const ext = extname(filePath).toLowerCase();
  const mime = MIME[ext];
  if (!mime) throw new Error(`Unsupported media type for ${basename(filePath)} (${ext})`);

  const init = await call(creds, 'POST', '/2/media/upload', {
    query: { command: 'INIT', total_bytes: String(data.length), media_type: mime, media_category: 'tweet_image' },
  });
  const mediaId = init?.data?.id ?? init?.data?.media_id_string ?? init?.media_id_string;
  if (!mediaId) throw new Error(`INIT returned no media id: ${JSON.stringify(init).slice(0, 200)}`);

  const CHUNK = 1024 * 1024;
  for (let i = 0, seg = 0; i < data.length; i += CHUNK, seg++) {
    const form = new FormData();
    form.set('command', 'APPEND');
    form.set('media_id', mediaId);
    form.set('segment_index', String(seg));
    form.set('media', new Blob([data.subarray(i, i + CHUNK)], { type: mime }), basename(filePath));
    await call(creds, 'POST', '/2/media/upload', { form });
  }

  await call(creds, 'POST', '/2/media/upload', { query: { command: 'FINALIZE', media_id: mediaId } });
  return mediaId;
}

export async function createPost(creds, { text, mediaIds = [], replyTo = null }) {
  const json = { text };
  if (mediaIds.length) json.media = { media_ids: mediaIds };
  if (replyTo) json.reply = { in_reply_to_tweet_id: replyTo };
  return call(creds, 'POST', '/2/tweets', { json });
}

export async function whoAmI(creds) {
  return call(creds, 'GET', '/2/users/me');
}
