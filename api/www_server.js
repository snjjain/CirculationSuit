// Static file server for the www directory — serves on port 8123
const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT   = parseInt(process.env.WWW_PORT || '8123', 10);
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

http.createServer((req, res) => {
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
