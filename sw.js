const CACHE = 'meal-planner-v2';
const SHELL = './index.html';
const FILES = ['./', SHELL];
// How long to wait for the network before falling back to the cached copy. A weak signal
// (e.g. inside a store) often doesn't fail outright — requests just hang for a minute or more.
const NETWORK_TIMEOUT = 3000;
// With no saved copy there's nothing to fall back to, so give a slow network longer before giving up
const NO_CACHE_TIMEOUT = 15000;

// Last resort when there's no saved copy and no connection. A browser error page never retries,
// and a home-screen app has no reload button, so this page offers one and keeps retrying itself.
// (The fetch keeps running in the background and saves the app for the retry if it gets through.)
const RETRY_PAGE = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Meal Planner</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 24px;
    min-height: 100vh; box-sizing: border-box; display: flex; flex-direction: column; align-items: center;
    justify-content: center; text-align: center; color: #333; background: #fff; }
  @media (prefers-color-scheme: dark) { body { color: #e4e4e4; background: #121212; } }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { font-size: 14px; color: #777; margin: 0 0 20px; max-width: 320px; line-height: 1.5; }
  button { background: #2a9d8f; color: #fff; border: 0; border-radius: 8px; padding: 12px 28px; font-size: 16px; }
</style></head><body>
<h1>Meal Planner can’t load right now</h1>
<p>The connection isn’t getting through and this device doesn’t have a saved copy yet. This page will keep trying on its own.</p>
<button onclick="location.reload()">Try again</button>
<script>setTimeout(() => location.reload(), 20000); addEventListener('online', () => location.reload());</script>
</body></html>`;
const retryPage = () => new Response(RETRY_PAGE, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  // Let the browser handle anything we don't cache itself (e.g. Claude API calls)
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // Every page load is the same single-page app, whatever the URL looks like
  // (home-screen launches can add ?query strings), so store and serve it under one key
  const isPage = req.mode === 'navigate';
  const key = isPage ? SHELL : req;
  const fromCache = () => caches.match(key, { ignoreSearch: true })
    .then(hit => hit || (isPage ? caches.match('./') : undefined))
    .catch(() => undefined);

  // Network first so updates show up when online, and refresh the cache whenever the network
  // answers — even if it's too slow and the cached copy was already shown
  const network = fetch(req).then(res => {
    // Only keep good responses — never cache an error page over the working app
    if (res.ok && res.type === 'basic' && !res.redirected) {
      const copy = res.clone();
      e.waitUntil(caches.open(CACHE).then(c => c.put(key, copy)));
    }
    return res;
  });
  e.waitUntil(network.catch(() => {}));

  e.respondWith(new Promise(resolve => {
    let timer;
    let settled = false;
    const done = res => {
      if (settled || !res) return;
      settled = true; clearTimeout(timer); resolve(res);
    };
    const giveUp = () => done(isPage ? retryPage() : Response.error());
    // Slow network: show the cached app and let the fetch finish in the background.
    // No cached app: keep waiting a while longer, then show the retry page.
    timer = setTimeout(() => fromCache().then(hit => {
      if (hit) done(hit);
      else if (!settled) timer = setTimeout(giveUp, NO_CACHE_TIMEOUT - NETWORK_TIMEOUT);
    }), NETWORK_TIMEOUT);
    network.then(
      res => res.ok ? done(res) : fromCache().then(hit => done(hit || res)),
      () => fromCache().then(hit => hit ? done(hit) : giveUp())
    );
  }));
});
