import { Client, OAuth1 } from '@xdevplatform/xdk';

import {
  buildPostBody,
  bytesToBase64,
} from './transport.mjs';

// This module exists only to prove that the pinned XDK package AND xqueue's
// Worker-safe adapter can inhabit the same Wrangler bundle. It intentionally
// performs no authentication, network request, media upload, or post creation.

export function xdkBundleSurface() {
  const body = buildPostBody({ text: 'bundle-probe' });
  const encoded = bytesToBase64(new Uint8Array([0]));

  return Object.freeze({
    clientConstructor: typeof Client === 'function',
    oauth1Constructor: typeof OAuth1 === 'function',
    adapterPostBodyValid: body.text === 'bundle-probe',
    adapterBase64Valid: encoded === 'AA==',
    livePublication: false,
    schedulerAuthority: false,
  });
}

export default {
  async fetch() {
    return Response.json({
      service: 'xqueue-xdk-bundle-probe',
      ...xdkBundleSurface(),
    });
  },
};
