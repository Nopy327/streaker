const offlinePage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Starting Streak Tracker</title>
  <style>
    html { background: #050b14; color: #e2e8f0; font: 16px system-ui, sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; }
    p { margin: 0; padding: 1.5rem; text-align: center; }
  </style>
</head>
<body>
  <p>Starting Streak Tracker…</p>
  <script>
    async function retry() {
      try {
        const response = await fetch('/?startup-ready=1', { cache: 'no-store' });
        if (response.ok) location.reload();
      } catch { /* The Mac's local server is still starting. */ }
    }
    setInterval(retry, 1500);
    retry();
  </script>
</body>
</html>`;

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  if (new URL(event.request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(new Request(event.request, { cache: 'no-store' })).catch(() =>
      new Response(offlinePage, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      }),
    ),
  );
});
