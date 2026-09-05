// Card definitions live here so that state, query and effects can all look a
// card up without importing cards.js (which imports them right back).

export const CARDS = Object.create(null);

export function register(defs) {
  for (const d of defs) {
    if (CARDS[d.id]) throw new Error(`Duplicate card id: ${d.id}`);
    CARDS[d.id] = d;
  }
  return CARDS;
}

export function cardDef(cardOrId) {
  const id = typeof cardOrId === 'string' ? cardOrId : cardOrId && cardOrId.defId;
  const d = CARDS[id];
  if (!d) throw new Error(`Unknown card definition: ${id}`);
  return d;
}

export function cardName(cardOrId) {
  try {
    return cardDef(cardOrId).name;
  } catch {
    return 'A spell';
  }
}
