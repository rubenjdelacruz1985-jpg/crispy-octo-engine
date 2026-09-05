// Opponent voice. Prefers ElevenLabs through the local /api/voice proxy (which
// holds the API key server-side); falls back to the browser's built-in speech,
// tuned per profile, when no key is configured. Never throws — worst case is
// silence, and gameplay never depends on it.

let serverVoice = null;   // null = untried, true = proxy works, false = fall back
let current = null;       // current <audio>, so a new line interrupts the old
let muted = false;

export function setMuted(v) { muted = !!v; if (muted) stopVoice(); }
export function isMuted() { return muted; }

export function stopVoice() {
  try { if (current) { current.pause(); current = null; } } catch { /* noop */ }
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch { /* noop */ }
}

export async function speak(profile, text) {
  if (!text || muted || !profile) return;
  stopVoice();

  if (serverVoice !== false) {
    try {
      const res = await fetch('/api/voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId: profile.voiceId, text }),
      });
      if (res.status === 200) {
        serverVoice = true;
        const url = URL.createObjectURL(await res.blob());
        const audio = new Audio(url);
        current = audio;
        const cleanup = () => URL.revokeObjectURL(url);
        audio.onended = cleanup; audio.onerror = cleanup;
        await audio.play().catch(() => {});
        return;
      }
      serverVoice = false; // 501 (no key) or any error → use the browser voice
    } catch {
      serverVoice = false;
    }
  }
  browserSpeak(profile, text);
}

function browserSpeak(profile, text) {
  try {
    if (!window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    u.rate = profile.rate || 1;
    u.pitch = profile.pitch || 1;
    const voices = window.speechSynthesis.getVoices();
    if (voices.length) {
      // Deterministic-but-distinct voice per profile so opponents sound apart.
      u.voice = voices[Math.abs(hash(profile.id)) % voices.length];
    }
    window.speechSynthesis.speak(u);
  } catch { /* noop */ }
}

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// Some browsers populate voices asynchronously; nudge them to load early.
try {
  if (window.speechSynthesis) window.speechSynthesis.getVoices();
  window.speechSynthesis?.addEventListener?.('voiceschanged', () => {});
} catch { /* noop */ }
