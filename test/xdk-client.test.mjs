import test from 'node:test';
import assert from 'node:assert/strict';

import {
  credsFromEnv,
  createPost,
  whoAmI,
} from '../src/xdk-client.mjs';

test('credsFromEnv maps all four OAuth 1.0a credentials', () => {
  const creds = credsFromEnv({
    X_API_KEY: 'key',
    X_API_SECRET: 'secret',
    X_ACCESS_TOKEN: 'token',
    X_ACCESS_SECRET: 'token-secret',
  });

  assert.deepEqual(creds, {
    apiKey: 'key',
    apiSecret: 'secret',
    accessToken: 'token',
    accessSecret: 'token-secret',
  });
});

test('credsFromEnv refuses incomplete credentials', () => {
  assert.throws(
    () =>
      credsFromEnv({
        X_API_KEY: 'key',
        X_API_SECRET: '',
        X_ACCESS_TOKEN: 'token',
        X_ACCESS_SECRET: '',
      }),
    /X_API_SECRET.*X_ACCESS_SECRET/,
  );
});

test('createPost sends plain text through posts.create', async () => {
  let received;

  const fakeClient = {
    posts: {
      async create(body) {
        received = body;

        return {
          data: {
            id: '123',
            text: body.text,
          },
        };
      },
    },
  };

  const result = await createPost(
    {},
    { text: 'integration test' },
    fakeClient,
  );

  assert.deepEqual(received, {
    text: 'integration test',
  });

  assert.equal(result.data.id, '123');
});

test('createPost maps media IDs into XDK camelCase schema', async () => {
  let received;

  const fakeClient = {
    posts: {
      async create(body) {
        received = body;
        return { data: { id: '123', text: body.text } };
      },
    },
  };

  await createPost(
    {},
    {
      text: 'media test',
      mediaIds: ['111', '222'],
    },
    fakeClient,
  );

  assert.deepEqual(received, {
    text: 'media test',
    media: {
      mediaIds: ['111', '222'],
    },
  });
});

test('createPost maps reply ID into XDK schema', async () => {
  let received;

  const fakeClient = {
    posts: {
      async create(body) {
        received = body;
        return { data: { id: '123', text: body.text } };
      },
    },
  };

  await createPost(
    {},
    {
      text: 'reply test',
      replyTo: '999',
    },
    fakeClient,
  );

  assert.deepEqual(received, {
    text: 'reply test',
    reply: {
      inReplyToTweetId: '999',
    },
  });
});

test('createPost rejects empty text before reaching X', async () => {
  let called = false;

  const fakeClient = {
    posts: {
      async create() {
        called = true;
      },
    },
  };

  await assert.rejects(
    createPost({}, { text: '' }, fakeClient),
    /non-empty text/,
  );

  assert.equal(called, false);
});

test('whoAmI delegates to users.getMe', async () => {
  let called = false;

  const fakeClient = {
    users: {
      async getMe() {
        called = true;

        return {
          data: {
            id: '1776902481454223361',
            username: 'PatrickCra94338',
          },
        };
      },
    },
  };

  const result = await whoAmI({}, fakeClient);

  assert.equal(called, true);
  assert.equal(result.data.username, 'PatrickCra94338');
});
