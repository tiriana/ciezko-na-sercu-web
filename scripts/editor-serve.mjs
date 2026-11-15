#!/usr/bin/env node
/** Statyczny serwer podglądu edytora: `npm run editor:build && node scripts/editor-serve.mjs`.
 * Serwujemy tylko wynik `build-editor.mjs`, bo w repo edytor nie ma `lib/`. */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = process.argv[2] ?? '.cache/editor-dist';
const PORT = Number(process.env.PORT ?? 4331);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.bin': 'application/octet-stream',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  let path = join(ROOT, normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, ''));
  try {
    const info = await stat(path);
    if (info.isDirectory()) path = join(path, 'index.html');
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
});

server.listen(PORT, () => console.log(`edytor: http://localhost:${PORT} (z ${ROOT})`));
