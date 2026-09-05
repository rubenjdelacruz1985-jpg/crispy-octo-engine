// Tiny static server so the ES modules load over http:// instead of file://.
//   npm start   →   http://localhost:5173
//
// Also proxies opponent voice lines to ElevenLabs when a key is configured, so
// the API key never reaches the browser:
//   ELEVENLABS_API_KEY=sk_... npm start
// Without the key, POST /api/voice returns 501 and the client uses the browser's
// built-in speech instead.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = process.cwd();

// Load a .env file if present, so the API key can live in a file you edit once
// instead of being typed on every launch. (Real env vars still win.)
try {
  const text = readFileSync(join(ROOT, '.env'), 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
} catch { /* no .env — that's fine, voices just fall back to the browser */ }

const PORT = Number(process.env.PORT || 5173);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 1e5) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

async function handleVoice(req, res) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    res.writeHead(501, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ error: 'no ELEVENLABS_API_KEY set; using browser fallback' }));
    return;
  }
  let body = {};
  try { body = JSON.parse(await readBody(req)); } catch { /* leave empty */ }
  const voiceId = String(body.voiceId || '').replace(/[^a-zA-Z0-9]/g, '');
  const text = String(body.text || '').slice(0, 300);
  if (!voiceId || !text) {
    res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'voiceId and text required' }));
    return;
  }
  try {
    const upstream = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.3 },
      }),
    });
    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      res.writeHead(502, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ error: 'elevenlabs error', status: upstream.status, detail: detail.slice(0, 300) }));
      return;
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' }).end(buf);
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(err && err.message || err) }));
  }
}

createServer(async (req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);

  if (req.method === 'POST' && url === '/api/voice') {
    return handleVoice(req, res);
  }

  const rel = normalize(url === '/' ? '/index.html' : url).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(PORT, () => console.log(`Spellforge running at http://localhost:${PORT}`));
