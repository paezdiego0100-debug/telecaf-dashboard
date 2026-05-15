// servidor.js — Servidor local para el dashboard
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.png':  'image/png',
};

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  let urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];

  let filePath;
  if (urlPath === '/index.html') {
    filePath = path.join(__dirname, 'docs', 'index.html');
  } else if (urlPath.startsWith('/data/')) {
    const archivo = urlPath.replace('/data/', '');
    filePath = path.join(__dirname, 'datos', archivo);
  } else {
    filePath = path.join(__dirname, 'docs', urlPath);
  }

  const ext = path.extname(filePath);
  const contentType = MIME[ext] || 'text/plain';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('No encontrado: ' + urlPath);
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   TELECAF Dashboard — Servidor local    ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
  console.log('  ✅ Dashboard disponible en:');
  console.log('  👉 http://localhost:' + PORT);
  console.log('');
  console.log('  Dejá esta ventana abierta.');
  console.log('  El dashboard se actualiza automáticamente.');
  console.log('');
  const { exec } = require('child_process');
  exec('start http://localhost:' + PORT);
});