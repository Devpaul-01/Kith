// pgrst-proxy.js
//
// supabase-js's PostgrestClient always targets `${SUPABASE_URL}/rest/v1/...`
// (this is hardcoded in the SDK — it's how hosted Supabase's Kong gateway
// routes to PostgREST). A bare `postgrest/postgrest` binary/image, as used
// in this repo's docker-compose.test.yml, serves routes at the schema
// root (e.g. `/users`), not under `/rest/v1`. In a real docker-compose
// run this mismatch is normally invisible because people only exercise
// this against a hosted Supabase project or they've placed Kong/Nginx in
// front of it; running PostgREST bare (as this sandbox must, since Docker
// isn't available here) exposes it directly.
//
// This is a measurement-infrastructure shim only — it changes nothing
// about the application or its tests. It listens on 3001 (the port
// SUPABASE_URL already points at throughout the test suite and
// scripts/measure.js) and forwards everything to PostgREST on 3002,
// stripping a leading /rest/v1 if present so both `/rest/v1/users` and
// `/users` resolve the same way.
const http = require('http');

const TARGET_HOST = '127.0.0.1';
const TARGET_PORT = 3002;
const LISTEN_PORT = process.env.PROXY_PORT || 3001;

const server = http.createServer((req, res) => {
  const path = req.url.startsWith('/rest/v1') ? req.url.slice('/rest/v1'.length) || '/' : req.url;

  const proxyReq = http.request(
    { host: TARGET_HOST, port: TARGET_PORT, path, method: req.method, headers: req.headers },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'pgrst-proxy upstream error', detail: err.message }));
  });

  req.pipe(proxyReq);
});

server.listen(LISTEN_PORT, () => {
  console.log(`pgrst-proxy listening on ${LISTEN_PORT} -> PostgREST on ${TARGET_PORT} (strips /rest/v1 prefix)`);
});
