// Mana costs and payment.
//
// A cost is written the way Magic writes it: digits are generic, letters are
// coloured. "2G" is two generic plus one green. "WW" is two white.

export const COLOURS = ['W', 'U', 'B', 'R', 'G'];

/** Parse "2WG" into { generic: 2, W: 1, U: 0, B: 0, R: 0, G: 1 }. */
export function parseCost(cost) {
  const out = { generic: 0, W: 0, U: 0, B: 0, R: 0, G: 0 };
  if (!cost) return out;
  for (const ch of String(cost).toUpperCase()) {
    if (ch >= '0' && ch <= '9') out.generic += Number(ch);
    else if (COLOURS.includes(ch)) out[ch] += 1;
    else if (ch === 'C') out.generic += 1;
    else throw new Error(`Bad mana symbol "${ch}" in cost "${cost}"`);
  }
  return out;
}

/** Total mana value (converted mana cost). */
export function manaValue(cost) {
  const c = parseCost(cost);
  return c.generic + COLOURS.reduce((n, col) => n + c[col], 0);
}

/** Render a cost for display: "2G" -> ["2","G"]. */
export function costSymbols(cost) {
  const c = parseCost(cost);
  const out = [];
  if (c.generic > 0 || manaValue(cost) === 0) out.push(String(c.generic));
  for (const col of COLOURS) for (let i = 0; i < c[col]; i++) out.push(col);
  return out;
}

/**
 * Work out which permanents to tap to pay `cost`.
 *
 * Coloured pips are matched to sources by exhaustive bipartite matching, so a
 * payment is found whenever one exists — no greedy near-misses where a dual
 * source gets spent on the wrong pip. Returns an array of instance ids to tap,
 * or null if the cost cannot be paid.
 */
export function findPayment(sources, cost) {
  const need = parseCost(cost);
  const avail = sources.filter((s) => !s.tapped && s.produces && s.produces.length);

  const pips = [];
  for (const col of COLOURS) for (let i = 0; i < need[col]; i++) pips.push(col);

  if (pips.length + need.generic > avail.length) return null;

  // Match each coloured pip to a distinct source that can produce it.
  const assigned = new Array(pips.length).fill(-1);
  const used = new Set();

  function match(pipIndex) {
    if (pipIndex === pips.length) return true;
    const colour = pips[pipIndex];
    for (let i = 0; i < avail.length; i++) {
      if (used.has(i)) continue;
      if (!avail[i].produces.includes(colour)) continue;
      used.add(i);
      assigned[pipIndex] = i;
      if (match(pipIndex + 1)) return true;
      used.delete(i);
      assigned[pipIndex] = -1;
    }
    return false;
  }

  if (!match(0)) return null;

  const payment = assigned.map((i) => avail[i].iid);

  // Anything still untapped can cover generic. Spend the least flexible first
  // so future casts this turn keep their options.
  const leftovers = avail
    .filter((_, i) => !used.has(i))
    .sort((a, b) => a.produces.length - b.produces.length);
  if (leftovers.length < need.generic) return null;
  for (let i = 0; i < need.generic; i++) payment.push(leftovers[i].iid);

  return payment;
}
