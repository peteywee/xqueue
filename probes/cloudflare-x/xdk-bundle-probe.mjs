import { Client, OAuth1 } from '@xdevplatform/xdk';

// This module exists only to prove that the pinned XDK package can be bundled by
// Wrangler for the Worker runtime. It intentionally performs no authentication,
// network request, media upload, or post creation.

export function xdkBundleSurface() {
  return Object.freeze({
    clientConstructor: typeof Client === 'function',
    oauth1Constructor: typeof OAuth1 === 'function',
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
