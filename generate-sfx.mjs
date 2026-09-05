// One-time sound-effect generator. Uses ElevenLabs' Sound Effects API to create
// real game sounds from text prompts and saves them to assets/sfx/<name>.mp3.
// The game then plays those files (see src/ui/sfx.js), falling back to synth.
//
//   node generate-sfx.mjs
//
// Needs an ELEVENLABS_API_KEY (read from .env or the environment) whose key has
// "Sound Effects" access enabled in the ElevenLabs dashboard. Safe to re-run
// (it overwrites the files). Costs a small amount of credits, once.

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';

// --- load key from .env (real env vars win) ---
try {
  for (const line of readFileSync(new URL('./.env', import.meta.url), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
} catch { /* no .env */ }

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) {
  console.error('No ELEVENLABS_API_KEY found (.env or env). Aborting.');
  process.exit(1);
}

// Each: [filename, prompt, duration seconds]
const SOUNDS = [
  ['tap',    'a single short soft click, tapping a game token', 0.6],
  ['draw',   'a quick playing card being drawn, light paper swish', 0.7],
  ['play',   'a playing card slapped down onto a wooden table, soft thud', 0.7],
  ['attack', 'a fast sword swing whoosh cutting through the air', 0.8],
  ['damage', 'a heavy blunt impact, armor hit with a low monster grunt', 0.9],
  ['cast',   'a magical spell being cast, shimmering rising arcane whoosh', 1.3],
  ['death',  'a monster dying, guttural roar fading into silence', 1.6],
  ['win',    'a short triumphant fantasy victory fanfare', 2.2],
  ['lose',   'a somber low fantasy defeat sting', 1.6],
];

mkdirSync(new URL('./assets/sfx/', import.meta.url), { recursive: true });

async function one([name, text, duration]) {
  const res = await fetch('https://api.elevenlabs.io/v1/sound-generation', {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, duration_seconds: duration, prompt_influence: 0.4 }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${name}: HTTP ${res.status} ${detail.slice(0, 160)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const out = new URL(`./assets/sfx/${name}.mp3`, import.meta.url);
  writeFileSync(out, buf);
  console.log(`  ✓ ${name}.mp3 (${(buf.length / 1024).toFixed(0)} KB)`);
}

console.log('Generating sound effects via ElevenLabs…');
let ok = 0;
for (const s of SOUNDS) {
  try { await one(s); ok++; }
  catch (e) {
    console.error('  ✗ ' + e.message);
    if (String(e.message).includes('401') || String(e.message).includes('403')) {
      console.error('\nYour API key needs "Sound Effects" access. Enable it in ElevenLabs →');
      console.error('Developers → API Keys → edit your key → set Sound Effects to Access.');
      break;
    }
  }
}
console.log(`\nDone — ${ok}/${SOUNDS.length} sounds generated into assets/sfx/.`);
