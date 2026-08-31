import { readFile } from 'node:fs/promises';

import {
  Client,
  OAuth1,
} from '@xdevplatform/xdk';

export function credsFromEnv(env = process.env) {
  const creds = {
    apiKey: env.X_API_KEY,
    apiSecret: env.X_API_SECRET,
    accessToken: env.X_ACCESS_TOKEN,
    accessSecret: env.X_ACCESS_SECRET,
  };

  const missing = [
    ['X_API_KEY', creds.apiKey],
    ['X_API_SECRET', creds.apiSecret],
    ['X_ACCESS_TOKEN', creds.accessToken],
    ['X_ACCESS_SECRET', creds.accessSecret],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length) {
    throw new Error(
      `Missing required X credential(s): ${missing.join(', ')}`
    );
  }

  return creds;
}

export function clientFromCreds(creds) {
  const oauth1 = new OAuth1({
    apiKey: creds.apiKey,
    apiSecret: creds.apiSecret,
    accessToken: creds.accessToken,
    accessTokenSecret: creds.accessSecret,
  });

  return new Client({
    oauth1,
  });
}

export async function whoAmI(
  creds,
  client = clientFromCreds(creds),
) {
  return client.users.getMe();
}

export async function uploadMedia(
  creds,
  filePath,
  client = clientFromCreds(creds),
) {
  if (!filePath) {
    throw new Error('uploadMedia requires a file path');
  }

  const bytes = await readFile(filePath);

  if (!bytes.length) {
    throw new Error(
      `Media file is empty: ${filePath}`
    );
  }

  const response = await client.media.upload({
    media: bytes.toString('base64'),
    mediaCategory: 'tweet_image',
  });

  const mediaId = response?.data?.id;

  if (!mediaId) {
    throw new Error(
      `X media upload returned no media ID: ${JSON.stringify(response)}`
    );
  }

  return String(mediaId);
}

export async function createPost(
  creds,
  {
    text,
    mediaIds = [],
    replyTo = null,
  },
  client = clientFromCreds(creds),
) {
  if (
    typeof text !== 'string' ||
    text.length === 0
  ) {
    throw new Error(
      'createPost requires non-empty text'
    );
  }

  const body = {
    text,
  };

  if (mediaIds.length) {
    body.media = {
      mediaIds: [...mediaIds],
    };
  }

  if (replyTo) {
    body.reply = {
      inReplyToTweetId: replyTo,
    };
  }

  return client.posts.create(body);
}
