// Local preview: serves index.html with demo data (no Google account needed).
// Usage: npm start  ->  http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.env.PORT) || 3000;
const file = path.join(__dirname, 'index.html');

http.createServer((req, res) => {
  if (req.url !== '/' && !req.url.startsWith('/?') && req.url !== '/index.html') {
    res.writeHead(404); return res.end('Not found');
  }
  fs.readFile(file, (err, html) => {
    if (err) { res.writeHead(500); return res.end(String(err)); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
}).listen(port, () => console.log(`Daily Helper preview (demo data): http://localhost:${port}`));
