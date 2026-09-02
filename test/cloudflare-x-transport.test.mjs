import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  buildPostBody,
  bytesToBase64,
  createPostViaClient,
  uploadMediaBytesViaClient,
  whoAmIViaClient,
} from '../probes/cloudflare-x/transport.mjs';
import { xdkBundleSurface } from '../probes/cloudflare-x/xdk-bundle-probe.mjs';

function fakeClient() {
  const calls = [];
  return {
    calls,
    users: {
      async getMe() {
        calls.push(['getMe']);
        return { data: { id: 'u1', username: 'tester' } };
      },
    },
    media: {
      async upload(body) {
        calls.push(['upload', body]);
        return { data: { id: 'm1' } };
      },
    },
    posts: {
      async create(body) {
        calls.push(['create', body]);
        return { data: { id: 'p1' } };
      },
    },
  };
}

test('post body preserves text, media IDs and reply schema exactly', () => {
  assert.deepEqual(
    buildPostBody({ text: 'hello', mediaIds: ['m1', 'm2'], replyTo: 'p0' }),
    {
      text: 'hello',
      media: { mediaIds: ['m1', 'm2'] },
      reply: { inReplyToTweetId: 'p0' },
    },
  );
});

test('post body rejects malformed text/media/reply input before dispatch', () => {
  assert.throws(() => buildPostBody({ text: '' }), /non-empty/);
  assert.throws(() => buildPostBody({ text: 'x', mediaIds: 'm1' }), /array/);
  assert.throws(() => buildPostBody({ text: 'x', mediaIds: [''] }), /media ID/);
  assert.throws(() => buildPostBody({ text: 'x', replyTo: '' }), /replyTo/);
});

test('media bytes encode without filesystem access and return exact media ID', async () => {
  const client = fakeClient();
  const id = await uploadMediaBytesViaClient(client, new Uint8Array([0, 1, 2, 255]));
  assert.equal(id, 'm1');
  assert.deepEqual(client.calls[0], [
    'upload',
    { media: 'AAEC/w==', mediaCategory: 'tweet_image' },
  ]);
});

test('empty or malformed media fails before client dispatch', async () => {
  const client = fakeClient();
  await assert.rejects(() => uploadMediaBytesViaClient(client, new Uint8Array()), /empty/);
  await assert.rejects(() => uploadMediaBytesViaClient(client, 'bytes'), /Uint8Array/);
  assert.equal(client.calls.length, 0);
});

test('media response without an ID fails closed', async () => {
  const client = { media: { async upload() { return { data: {} }; } } };
  await assert.rejects(() => uploadMediaBytesViaClient(client, new Uint8Array([1])), /no media ID/);
});

test('post transport delegates exactly once and propagates transport failure', async () => {
  const client = fakeClient();
  const result = await createPostViaClient(client, { text: 'hello' });
  assert.equal(result.data.id, 'p1');
  assert.deepEqual(client.calls, [['create', { text: 'hello' }]]);

  const failing = { posts: { async create() { throw new Error('transport failed'); } } };
  await assert.rejects(() => createPostViaClient(failing, { text: 'hello' }), /transport failed/);
});

test('identity probe exposes only the read-only users.getMe surface', async () => {
  const client = fakeClient();
  const result = await whoAmIViaClient(client);
  assert.equal(result.data.username, 'tester');
  assert.deepEqual(client.calls, [['getMe']]);
});

test('Worker-safe transport source has no node filesystem import', async () => {
  const source = await readFile(new URL('../probes/cloudflare-x/transport.mjs', import.meta.url), 'utf8');
  assert.equal(/node:fs|readFile|writeFile/.test(source), false);
});

test('inert Wrangler probe exercises XDK and the Worker-safe adapter in one module graph', async () => {
  const source = await readFile(new URL('../probes/cloudflare-x/xdk-bundle-probe.mjs', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/transport\.mjs'/);

  const surface = xdkBundleSurface();
  assert.equal(surface.clientConstructor, true);
  assert.equal(surface.oauth1Constructor, true);
  assert.equal(surface.adapterPostBodyValid, true);
  assert.equal(surface.adapterBase64Valid, true);
  assert.equal(surface.livePublication, false);
  assert.equal(surface.schedulerAuthority, false);
});
