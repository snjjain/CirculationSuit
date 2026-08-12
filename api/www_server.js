// Static file server for the www directory — serves on port 8123
// Also proxies /api/* to the API server on port 8001 so only one port needs to be open
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT   = parseInt(process.env.WWW_PORT || '8123', 10);
const API_PORT = parseInt(process.env.API_PORT || '8001', 10);
const WWW    = path.join(__dirname, '..', 'www');
const MIME   = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
};

function proxyToApi(req, res) {
  const options = {
    hostname: '127.0.0.1',
    port: API_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${API_PORT}` },
  };
  const proxy = http.request(options, proxyRes => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });
  proxy.on('error', () => { res.writeHead(502); res.end('API unavailable'); });
  req.pipe(proxy, { end: true });
}

http.createServer((req, res) => {
  // Proxy all /api/ requests to the API server on port 8001
  if (req.url.startsWith('/api/')) {
    proxyToApi(req, res);
    return;
  }

  let urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';

  const filePath = path.join(WWW, urlPath);
  // Prevent path traversal
  if (!filePath.startsWith(WWW)) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // SPA fallback: serve index.html for unknown routes
      fs.readFile(path.join(WWW, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store, no-cache, must-revalidate', 'Pragma': 'no-cache' });
        res.end(d2);
      });
      return;
    }
    const ext  = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    // Service worker and HTML must never be browser-cached — SW version bump only works
    // if the browser always fetches the latest sw.js from the server.
    const noCache = urlPath === '/sw.js' || ext === '.html';
    const headers = { 'Content-Type': type };
    if (noCache) {
      headers['Cache-Control'] = 'no-store, no-cache, must-revalidate';
      headers['Pragma'] = 'no-cache';
    } else {
      headers['Cache-Control'] = 'public, max-age=31536000'; // versioned assets cache long
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Patrika www server running on http://localhost:${PORT}`);
});
