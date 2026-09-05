// Sound effects. Prefers real audio files in /assets/sfx/<name>.mp3 (generate
// them once with `node generate-sfx.mjs` using an ElevenLabs key). If a file is
// missing, falls back to a synthesized tone so there's always *some* feedback.
// Never throws; if audio is unavailable it's silent.

let ctx = null;
let muted = false;

function ac() {
  if (!ctx) {
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { ctx = null; }
  }
  return ctx;
}

export function resume() {
  const c = ac();
  if (c && c.state === 'suspended') c.resume().catch(() => {});
}
export function setMuted(v) { muted = !!v; }
export function isMuted() { return muted; }

/* ---- real audio files (loaded if present) ---- */
const NAMES = ['tap', 'draw', 'play', 'attack', 'damage', 'cast', 'death', 'win', 'lose'];
const files = {};   // name -> ready HTMLAudioElement, once it loads
for (const n of NAMES) {
  try {
    const a = new Audio(`assets/sfx/${n}.mp3`);
    a.preload = 'auto';
    a.addEventListener('canplaythrough', () => { files[n] = a; }, { once: true });
    a.addEventListener('error', () => { delete files[n]; });
  } catch { /* ignore */ }
}

function play(name) {
  if (muted) return;
  const a = files[name];
  if (a) {
    try { const c = a.cloneNode(); c.volume = 0.7; c.play().catch(() => {}); return; } catch { /* fall back */ }
  }
  (proc[name] || (() => {}))();
}

/* ---- synthesized fallbacks ---- */
function tone(freq, dur, type = 'sine', vol = 0.2, slideTo = null) {
  const c = ac();
  if (!c || muted) return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, slideTo), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(c.destination);
  osc.start(t);
  osc.stop(t + dur + 0.03);
}
function noise(dur, vol = 0.15, filterFreq = 1000, q = 1) {
  const c = ac();
  if (!c || muted) return;
  const t = c.currentTime;
  const buf = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate * dur)), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = c.createBufferSource();
  src.buffer = buf;
  const filt = c.createBiquadFilter();
  filt.type = 'bandpass';
  filt.frequency.value = filterFreq;
  filt.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filt).connect(g).connect(c.destination);
  src.start(t);
  src.stop(t + dur);
}

const proc = {
  cast:   () => { tone(320, 0.24, 'triangle', 0.16, 920); },
  attack: () => { tone(430, 0.18, 'sawtooth', 0.14, 150); noise(0.12, 0.07, 1700, 0.8); },
  damage: () => { tone(150, 0.20, 'sine', 0.26, 60); noise(0.07, 0.12, 500, 0.7); },
  tap:    () => { tone(880, 0.05, 'square', 0.06); },
  draw:   () => { noise(0.13, 0.05, 2400, 1.2); },
  play:   () => { tone(240, 0.14, 'triangle', 0.12, 420); },
  death:  () => { tone(200, 0.32, 'sawtooth', 0.16, 70); noise(0.18, 0.06, 320, 0.6); },
  win:    () => { [523, 659, 784].forEach((f, i) => setTimeout(() => tone(f, 0.2, 'triangle', 0.18), i * 120)); },
  lose:   () => { tone(300, 0.5, 'sine', 0.2, 110); },
};

export const sfx = {
  cast:   () => play('cast'),
  attack: () => play('attack'),
  damage: () => play('damage'),
  tap:    () => play('tap'),
  draw:   () => play('draw'),
  play:   () => play('play'),
  death:  () => play('death'),
  win:    () => play('win'),
  lose:   () => play('lose'),
};
