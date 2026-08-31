import 'dotenv/config';

import {
  Client,
  OAuth1,
  type OAuth1Config,
  type ClientConfig,
} from '@xdevplatform/xdk';

function required(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

const oauth1Config: OAuth1Config = {
  apiKey: required('X_API_KEY'),
  apiSecret: required('X_API_SECRET'),
  accessToken: required('X_ACCESS_TOKEN'),
  accessTokenSecret: required('X_ACCESS_SECRET'),
};

const oauth1 = new OAuth1(oauth1Config);

const config: ClientConfig = {
  oauth1,
};

const client = new Client(config);

async function main(): Promise<void> {
  const response = await client.users.getMe();

  if (!response.data) {
    throw new Error(`X returned no user data: ${JSON.stringify(response)}`);
  }

  console.log('X AUTH PASS');
  console.log(`id:       ${response.data.id}`);
  console.log(`username: ${response.data.username}`);
  console.log(`name:     ${response.data.name}`);
}

main().catch((error: unknown) => {
  console.error('X AUTH FAIL');

  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(error);
  }

  process.exit(1);
});
