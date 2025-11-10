import 'dotenv/config';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HOST = process.env.FRONTEND_HOST || '0.0.0.0';
const PORT = parseInt(process.env.FRONTEND_PORT || '1026', 10);
const CERT = process.env.FRONTEND_CERT_FILE || '/home/ubuntu/.acme-certs/fullchain.pem';
const KEY = process.env.FRONTEND_KEY_FILE || '/home/ubuntu/.acme-certs/privkey.pem';

const options = {
  cert: fs.readFileSync(CERT),
  key: fs.readFileSync(KEY)
};

const publicDir = path.join(__dirname, 'public');

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const server = https.createServer(options, (req, res) => {
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(publicDir, path.normalize(urlPath));

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[frontend] Serving HTTPS on https://${HOST}:${PORT}`);
  console.log(`[frontend] Public dir: ${publicDir}`);
});