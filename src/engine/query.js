// Derived characteristics. Power, toughness and keywords are never stored on a
// permanent — they are recomputed from the printed card plus counters,
// temporary effects and any static buffs on the battlefield.

import { cardDef } from './registry.js';

export { cardDef };

export function isType(card, type) {
  const d = cardDef(card);
  return d.types.includes(type);
}

export const isCreature = (c) => isType(c, 'Creature');
export const isLand = (c) => isType(c, 'Land');
export const isPermanent = (c) => ['Creature', 'Land', 'Artifact', 'Enchantment'].some((t) => isType(c, t));
export const isInstant = (c) => isType(c, 'Instant');
export const isSorcery = (c) => isType(c, 'Sorcery');

/** Static "other creatures you control get +X/+Y" effects in play. */
function anthemBonus(g, card) {
  let p = 0;
  let t = 0;
  if (!g) return { p, t };
  for (const owner of g.players) {
    for (const src of owner.battlefield) {
      const d = cardDef(src);
      if (!d.anthem) continue;
      if (src.controller !== card.controller) continue;
      if (src.iid === card.iid && d.anthem.others !== false) continue;
      p += d.anthem.power || 0;
      t += d.anthem.toughness || 0;
    }
  }
  return { p, t };
}

export function power(g, card) {
  const d = cardDef(card);
  const a = anthemBonus(g, card);
  return Math.max(0, (d.power || 0) + card.counters + card.tempPower + a.p);
}

export function toughness(g, card) {
  const d = cardDef(card);
  const a = anthemBonus(g, card);
  return (d.toughness || 0) + card.counters + card.tempToughness + a.t;
}

export function keywords(g, card) {
  const d = cardDef(card);
  const set = new Set([...(d.keywords || []), ...(card.tempKeywords || [])]);
  return set;
}

export function has(g, card, keyword) {
  return keywords(g, card).has(keyword);
}

/** A creature can attack if it is untapped and not summoning sick (or has haste). */
export function canAttack(g, card) {
  if (!isCreature(card) || card.zone !== 'battlefield') return false;
  if (card.tapped) return false;
  if (has(g, card, 'defender')) return false;
  if (card.summoningSick && !has(g, card, 'haste')) return false;
  return true;
}

export function canBlock(g, blocker) {
  return isCreature(blocker) && blocker.zone === 'battlefield' && !blocker.tapped;
}

/** Evasion check for a single blocker against a single attacker. */
export function blockLegal(g, attacker, blocker) {
  if (!canBlock(g, blocker)) return false;
  if (has(g, attacker, 'flying') && !has(g, blocker, 'flying') && !has(g, blocker, 'reach')) return false;
  return true;
}

/** Damage that would destroy this creature right now. */
export function lethalRemaining(g, card) {
  return Math.max(0, toughness(g, card) - card.damage);
}

export function isDead(g, card) {
  if (!isCreature(card)) return false;
  if (toughness(g, card) <= 0) return true;
  if (card.dealtDeathtouch) return true;
  return card.damage >= toughness(g, card) && toughness(g, card) > 0;
}

/**
 * Mana sources a player could still tap this turn.
 *
 * Summoning sickness only restricts a creature's own tap abilities (rule
 * 302.6) — it never applies to lands or artifacts, so a mana rock works the
 * turn it enters but a freshly cast mana dork creature does not.
 */
export function manaSources(g, playerId) {
  return g.players[playerId].battlefield.filter((c) => {
    if (!c.produces || c.tapped) return false;
    if (isCreature(c) && c.summoningSick && !has(g, c, 'haste')) return false;
    return true;
  });
}

export function availableMana(g, playerId) {
  return manaSources(g, playerId).length;
}
