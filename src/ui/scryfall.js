// Live card-art lookup against Scryfall, for the "real cards" decks only.
//
// This never bundles or redistributes Wizards' artwork — it hotlinks
// Scryfall's own CDN at display time, exactly as Scryfall's usage
// guidelines ask for (cache the JSON lookup, not the images). It fails
// silently and lets the caller fall back to placeholder art: a network
// hiccup, an ad blocker, or a sandbox with no outbound access to Scryfall
// must never break the game, since art is cosmetic and gameplay never
// depends on it.
//
// See https://scryfall.com/docs/api for terms. Unofficial fan use only —
// not affiliated with or endorsed by Wizards of the Coast or Scryfall.

const CACHE_KEY = 'spellforge:scryfall-cache:v1';
const memory = new Map();
let disk = null;

function loadDisk() {
  if (disk) return disk;
  try {
    disk = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
  } catch {
    disk = {};
  }
  return disk;
}

function saveDisk() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(disk));
  } catch {
    /* private browsing, quota exceeded, etc. — art just won't persist */
  }
}

/**
 * Look up a real card's Scryfall image by exact name.
 * Resolves to a { small, normal, art_crop } URL set, or null if unavailable
 * for any reason (offline, blocked, rate-limited, name not found).
 */
export async function fetchCardImage(name) {
  if (memory.has(name)) return memory.get(name);
  const cached = loadDisk()[name];
  if (cached) {
    memory.set(name, cached);
    return cached;
  }

  try {
    const res = await fetch(`https://api.scryfall.com/cards/named?exact=${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`Scryfall ${res.status}`);
    const card = await res.json();
    const uris = card.image_uris || (card.card_faces && card.card_faces[0] && card.card_faces[0].image_uris);
    if (!uris) throw new Error('no image_uris on card');
    const images = { small: uris.small, normal: uris.normal, art_crop: uris.art_crop };
    memory.set(name, images);
    disk[name] = images;
    saveDisk();
    return images;
  } catch {
    memory.set(name, null); // don't retry a failed lookup every render this session
    return null;
  }
}
