// The primitives that card effects are built from.
//
// Effects never touch the stack or state-based actions directly; they queue
// triggers and let rules.js drain them, which keeps resolution order honest.

import { moveCard, log, findCard } from './state.js';
import { cardDef, cardName } from './registry.js';
import { power, has } from './query.js';

export function resolveTarget(g, tgt) {
  if (!tgt) return null;
  if (tgt.t === 'player') return g.players[tgt.id] || null;
  if (tgt.t === 'card') {
    const c = findCard(g, tgt.iid);
    return c && c.zone === 'battlefield' ? c : null;
  }
  if (tgt.t === 'spell') return g.stack.find((s) => s.sid === tgt.sid) || null;
  return null;
}

export const isPlayerTarget = (tgt) => !!tgt && tgt.t === 'player';

export function queueTrigger(g, trigger) {
  g.pendingTriggers.push(trigger);
}

export function gainLife(g, playerId, amount) {
  if (amount <= 0) return;
  g.players[playerId].life += amount;
  log(g, `${g.players[playerId].name} gains ${amount} life.`);
}

export function loseLife(g, playerId, amount) {
  if (amount <= 0) return;
  g.players[playerId].life -= amount;
  log(g, `${g.players[playerId].name} loses ${amount} life.`);
}

/**
 * Damage from `source` to a creature or player.
 * Deathtouch marks the creature for destruction; lifelink pays the controller.
 */
export function dealDamage(g, target, amount, source) {
  if (amount <= 0 || !target) return;
  const deathtouch = source ? has(g, source, 'deathtouch') : false;
  const lifelink = source ? has(g, source, 'lifelink') : false;
  const srcName = source ? cardName(source) : 'An effect';

  if (target.life !== undefined) {
    target.life -= amount;
    log(g, `${srcName} deals ${amount} damage to ${target.name}.`);
  } else {
    target.damage += amount;
    if (deathtouch) target.dealtDeathtouch = true;
    log(g, `${srcName} deals ${amount} damage to ${cardName(target)}.`);
  }

  if (lifelink && source) gainLife(g, source.controller, amount);
}

export function destroy(g, card, reason = 'destroyed') {
  if (!card || card.zone !== 'battlefield') return;
  const d = cardDef(card);
  log(g, `${d.name} is ${reason}.`);
  const controller = card.controller;
  moveCard(g, card, card.owner, 'graveyard');
  if (d.onDeath) queueTrigger(g, { defId: card.defId, controller, kind: 'death', sourceIid: card.iid });
}

export function exileCard(g, card) {
  if (!card || card.zone !== 'battlefield') return;
  log(g, `${cardName(card)} is exiled.`);
  moveCard(g, card, card.owner, 'exile');
}

export function bounce(g, card) {
  if (!card || card.zone !== 'battlefield') return;
  log(g, `${cardName(card)} returns to its owner's hand.`);
  moveCard(g, card, card.owner, 'hand');
}

export function draw(g, playerId, n = 1) {
  const p = g.players[playerId];
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    if (p.library.length === 0) {
      // Drawing from an empty library loses the game (a state-based action).
      p.hasDrawnFromEmpty = true;
      log(g, `${p.name} tried to draw from an empty deck.`);
      break;
    }
    moveCard(g, p.library[p.library.length - 1], playerId, 'hand');
    drawn++;
  }
  if (drawn) log(g, `${p.name} draws ${drawn} card${drawn === 1 ? '' : 's'}.`);
}

export function discardRandom(g, playerId, n = 1, rng = Math.random) {
  const p = g.players[playerId];
  for (let i = 0; i < n && p.hand.length; i++) {
    const c = p.hand[Math.floor(rng() * p.hand.length)];
    moveCard(g, c, playerId, 'graveyard');
    log(g, `${p.name} discards ${cardName(c)}.`);
  }
}

export function pump(g, card, p, t, keywords = []) {
  if (!card || card.zone !== 'battlefield') return;
  card.tempPower += p;
  card.tempToughness += t;
  for (const k of keywords) if (!card.tempKeywords.includes(k)) card.tempKeywords.push(k);
  const sign = (n) => (n >= 0 ? `+${n}` : `${n}`);
  log(g, `${cardName(card)} gets ${sign(p)}/${sign(t)}${keywords.length ? ` and gains ${keywords.join(', ')}` : ''}.`);
}

export function addCounters(g, card, n) {
  if (!card || card.zone !== 'battlefield') return;
  card.counters += n;
  log(g, `${cardName(card)} gets ${n} +1/+1 counter${n === 1 ? '' : 's'}.`);
}

/** Remove a spell from the stack and put its card in the graveyard. */
export function counterSpell(g, spell) {
  if (!spell) return;
  const idx = g.stack.indexOf(spell);
  if (idx < 0) return;
  g.stack.splice(idx, 1);
  log(g, `${cardName(spell.defId)} is countered.`);
  if (spell.card) moveCard(g, spell.card, spell.card.owner, 'graveyard');
}

/** Two creatures deal damage equal to their power to each other. */
export function fight(g, a, b) {
  if (!a || !b || a.zone !== 'battlefield' || b.zone !== 'battlefield') return;
  log(g, `${cardName(a)} fights ${cardName(b)}.`);
  const pa = power(g, a);
  const pb = power(g, b);
  dealDamage(g, b, pa, a);
  dealDamage(g, a, pb, b);
}
