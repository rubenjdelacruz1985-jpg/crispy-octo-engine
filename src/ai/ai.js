// The AI opponent.
//
// Everything in this file works from a *view* — the redacted snapshot produced
// by viewFor(). A view has no `library` key at all and the opponent's hand is a
// list of face-down placeholders, so the AI cannot read your cards even by
// mistake: the information is not in the object it is handed.
//
// The style is heuristic, not search: evaluate the board, price every legal
// play, take the best one above zero.

import {
  power, toughness, has, isCreature, isLand, isInstant, cardDef, blockLegal,
} from '../engine/query.js';
import { manaValue } from '../engine/mana.js';

// --------------------------------------------------------- evaluation ----

const KEYWORD_VALUE = {
  flying: 1.5, trample: 0.8, deathtouch: 1.2, lifelink: 1.0,
  'first strike': 0.8, 'double strike': 1.8, vigilance: 0.5, menace: 0.6, reach: 0.3,
};

/** Roughly what a creature on the battlefield is worth. */
export function creatureValue(v, c) {
  if (!isCreature(c)) return 0;
  const d = cardDef(c);
  let score = power(v, c) * 1.0 + toughness(v, c) * 0.75;
  for (const [kw, val] of Object.entries(KEYWORD_VALUE)) if (has(v, c, kw)) score += val;
  if (d.anthem) score += 2;
  if (d.onEnter) score += 0.3;
  score += manaValue(d.cost) * 0.25;
  if (c.tapped) score -= 0.2;
  return score;
}

function boardScore(v, me) {
  const them = 1 - me;
  const mine = v.players[me];
  const theirs = v.players[them];
  const creatures = (p) => p.battlefield.filter(isCreature).reduce((n, c) => n + creatureValue(v, c), 0);
  return (
    (mine.life - theirs.life) * 0.55 +
    (creatures(mine) - creatures(theirs)) +
    (mine.hand.length - theirs.handCount) * 0.45 +
    (mine.battlefield.filter(isLand).length - theirs.battlefield.filter(isLand).length) * 0.15
  );
}

const untapped = (p) => p.battlefield.filter((c) => isCreature(c) && !c.tapped);

/** Worst case damage the opponent could swing for next turn. */
function incomingThreat(v, me) {
  const them = 1 - me;
  return v.players[them].battlefield
    .filter((c) => isCreature(c))
    .reduce((n, c) => n + power(v, c), 0);
}

// ------------------------------------------------------------ targeting ----

const opponentCreatures = (v, me) => v.players[1 - me].battlefield.filter(isCreature);
const myCreatures = (v, me) => v.players[me].battlefield.filter(isCreature);

function bestBy(list, fn) {
  let best = null;
  let bestScore = -Infinity;
  for (const item of list) {
    const s = fn(item);
    if (s > bestScore) { bestScore = s; best = item; }
  }
  return best;
}

function refFor(c) { return { t: 'card', iid: c.iid }; }

function optionHas(options, ref) {
  return options.some((o) => {
    if (o.t !== ref.t) return false;
    if (o.t === 'card') return o.iid === ref.iid;
    if (o.t === 'player') return o.id === ref.id;
    if (o.t === 'spell') return o.sid === ref.sid;
    return false;
  });
}

function findCardInView(v, iid) {
  for (const p of v.players) {
    for (const z of ['battlefield', 'hand', 'graveyard', 'exile']) {
      const c = p[z].find((x) => x.iid === iid);
      if (c) return c;
    }
  }
  return null;
}

/**
 * Pick targets for a spell or triggered ability.
 * Returns an array of target refs, or null if there is no worthwhile choice.
 */
export function pickTargets(v, me, specs, options, hint) {
  const kind = (hint && hint.kind) || 'generic';
  const them = 1 - me;
  const theirLife = v.players[them].life;

  const killable = (c, dmg) => toughness(v, c) - c.damage <= dmg;

  switch (kind) {
    case 'damage': {
      const amount = hint.amount || 1;
      const opts = options[0];
      const targets = opponentCreatures(v, me).filter((c) => optionHas(opts, refFor(c)));
      const lethalNow = optionHas(opts, { t: 'player', id: them }) && theirLife <= amount;
      if (lethalNow) return [{ t: 'player', id: them }];

      const kills = targets.filter((c) => killable(c, amount));
      if (kills.length) {
        const pick = bestBy(kills, (c) => creatureValue(v, c));
        // Only spend removal on something that is actually worth a card.
        if (creatureValue(v, pick) >= 2.2 || amount <= 2) return [refFor(pick)];
      }
      if (optionHas(opts, { t: 'player', id: them }) && theirLife <= 6) return [{ t: 'player', id: them }];
      if (kills.length) return [refFor(bestBy(kills, (c) => creatureValue(v, c)))];
      if (optionHas(opts, { t: 'player', id: them })) return [{ t: 'player', id: them }];
      return null;
    }

    case 'destroy':
    case 'exile':
    case 'bounce': {
      const opts = options[0];
      const targets = opponentCreatures(v, me).filter((c) => optionHas(opts, refFor(c)));
      if (!targets.length) return null;
      const pick = bestBy(targets, (c) => creatureValue(v, c));
      if (creatureValue(v, pick) < 2 && kind !== 'exile') return null;
      return [refFor(pick)];
    }

    case 'debuff': {
      const opts = options[0];
      const amount = -(hint.t || 0);
      const targets = opponentCreatures(v, me).filter((c) => optionHas(opts, refFor(c)));
      const kills = targets.filter((c) => toughness(v, c) - c.damage <= amount);
      if (kills.length) return [refFor(bestBy(kills, (c) => creatureValue(v, c)))];
      return null;
    }

    case 'pump': {
      const opts = options[0];
      const mine = myCreatures(v, me).filter((c) => optionHas(opts, refFor(c)));
      if (!mine.length) return null;
      const inCombat = mine.filter((c) => c.attacking || c.blocking !== null);
      const pool = inCombat.length ? inCombat : mine;
      return [refFor(bestBy(pool, (c) => creatureValue(v, c)))];
    }

    case 'counters': {
      const opts = options[0];
      const mine = myCreatures(v, me).filter((c) => optionHas(opts, refFor(c)));
      if (!mine.length) return null;
      // Counters are best on evasive or already-large bodies.
      return [refFor(bestBy(mine, (c) => creatureValue(v, c) + (has(v, c, 'flying') || has(v, c, 'trample') ? 2 : 0)))];
    }

    case 'fight': {
      const mine = myCreatures(v, me).filter((c) => optionHas(options[0], refFor(c)));
      const theirs = opponentCreatures(v, me).filter((c) => optionHas(options[1], refFor(c)));
      let best = null;
      let bestScore = 0;
      for (const a of mine) {
        for (const b of theirs) {
          const bDies = power(v, a) >= toughness(v, b) - b.damage || has(v, a, 'deathtouch');
          const aDies = power(v, b) >= toughness(v, a) - a.damage || has(v, b, 'deathtouch');
          const s = (bDies ? creatureValue(v, b) : 0) - (aDies ? creatureValue(v, a) : 0);
          if (s > bestScore) { bestScore = s; best = [refFor(a), refFor(b)]; }
        }
      }
      return best;
    }

    case 'counter': {
      const opts = options[0];
      if (!opts.length) return null;
      const scored = opts.map((o) => {
        const entry = v.stack.find((s) => s.sid === o.sid);
        if (!entry) return { o, score: -1 };
        if (entry.controller === me) return { o, score: -1 };
        const d = cardDef(entry.defId);
        let score = manaValue(d.cost) + (d.types.includes('Creature') ? d.power + d.toughness : 3);
        // Countering their removal aimed at our best creature is high value.
        if (entry.targets.some((t) => t.t === 'card' && (findCardInView(v, t.iid) || {}).controller === me)) score += 3;
        return { o, score };
      }).filter((x) => x.score > 0);
      if (!scored.length) return null;
      scored.sort((a, b) => b.score - a.score);
      return [scored[0].o];
    }

    case 'player': {
      const opts = options[0];
      const ref = { t: 'player', id: them };
      return optionHas(opts, ref) ? [ref] : (opts.length ? [opts[0]] : null);
    }

    default: {
      // Nothing smarter to say: take the first legal option for each spec.
      if (options.some((o) => !o.length)) return null;
      return options.map((o) => o[0]);
    }
  }
}

// ----------------------------------------------------------- casting ----

const COMBAT_WINDOWS = new Set(['declare_blockers', 'combat_damage']);

/** How much we want to make this play right now. Above zero means do it. */
function scoreCast(v, me, action) {
  const card = v.players[me].hand.find((c) => c.iid === action.iid);
  if (!card) return { score: -1 };
  const d = cardDef(card);
  const hint = d.ai || {};
  const myTurn = v.activePlayer === me;
  const them = 1 - me;
  const theirLife = v.players[them].life;

  // Creatures and other permanents: play the biggest thing we can afford.
  if (d.types.includes('Creature')) {
    const base = 3 + manaValue(d.cost) * 1.2 + (d.power + d.toughness) * 0.35;
    let bonus = 0;
    for (const [kw, val] of Object.entries(KEYWORD_VALUE)) if ((d.keywords || []).includes(kw)) bonus += val * 0.6;
    if (d.anthem && myCreatures(v, me).length >= 2) bonus += 2;
    return { score: base + bonus };
  }

  const targets = action.specs.length ? pickTargets(v, me, action.specs, action.options, hint) : [];
  if (action.specs.length && !targets) return { score: -1 };

  const value = { targets };

  switch (hint.kind) {
    case 'damage': {
      const amount = hint.amount || 1;
      const t = targets[0];
      if (t.t === 'player') {
        // Only burn face when it closes the game or we have nothing better.
        if (theirLife <= amount) return { ...value, score: 100 };
        return { ...value, score: myTurn && v.step === 'main2' && !opponentCreatures(v, me).length ? 1.2 : -1 };
      }
      const c = findCardInView(v, t.iid);
      if (!c) return { score: -1 };
      const dies = toughness(v, c) - c.damage <= amount;
      if (!dies) return { score: -1 };
      const good = COMBAT_WINDOWS.has(v.step) || v.step === 'end' || (myTurn && c.attacking === false);
      return { ...value, score: good ? creatureValue(v, c) : creatureValue(v, c) - 2 };
    }

    case 'debuff': {
      const c = findCardInView(v, targets[0].iid);
      if (!c) return { score: -1 };
      return { ...value, score: creatureValue(v, c) * (COMBAT_WINDOWS.has(v.step) || v.step === 'end' ? 1 : 0.7) };
    }

    case 'destroy':
    case 'exile': {
      const c = findCardInView(v, targets[0].iid);
      if (!c) return { score: -1 };
      return { ...value, score: creatureValue(v, c) };
    }

    case 'bounce': {
      const c = findCardInView(v, targets[0].iid);
      if (!c) return { score: -1 };
      // Bounce is tempo, not removal — best on something expensive, or to save
      // one of ours is not possible here, so only when it swings combat.
      const worth = manaValue(cardDef(c).cost) >= 3 || COMBAT_WINDOWS.has(v.step);
      return { ...value, score: worth ? creatureValue(v, c) * 0.7 : -1 };
    }

    case 'pump': {
      if (!COMBAT_WINDOWS.has(v.step)) return { score: -1 };
      const c = findCardInView(v, targets[0].iid);
      if (!c || (!c.attacking && c.blocking === null)) return { score: -1 };
      return { ...value, score: pumpValue(v, me, c, hint) };
    }

    case 'mass_pump': {
      const attackers = myCreatures(v, me).filter((c) => c.attacking);
      if (!attackers.length || !COMBAT_WINDOWS.has(v.step)) return { score: -1 };
      const extra = attackers.length * ((hint.p || 0) + (hint.t || 0) * 0.5);
      return { ...value, score: extra >= 3 ? extra : -1 };
    }

    case 'counters': {
      const c = findCardInView(v, targets[0].iid);
      return c ? { ...value, score: 2.5 } : { score: -1 };
    }

    case 'fight': {
      const b = findCardInView(v, targets[1].iid);
      return b ? { ...value, score: creatureValue(v, b) } : { score: -1 };
    }

    case 'counter': {
      return { ...value, score: 6 };
    }

    case 'draw': {
      const n = hint.n || 1;
      const lowOnCards = v.players[me].hand.length <= 3;
      const goodWindow = !myTurn && v.step === 'end';
      if (isInstant(card) && !goodWindow && !lowOnCards) return { score: -1 };
      return { ...value, score: 2 + n * 0.8 };
    }

    case 'drain': {
      const n = hint.n || 2;
      if (theirLife <= n) return { ...value, score: 100 };
      return { ...value, score: v.players[me].hand.length > 4 || theirLife <= 8 ? 1.5 : -1 };
    }

    case 'discard': {
      return { ...value, score: v.players[them].handCount > 0 ? 1.6 : -1 };
    }

    default:
      return { ...value, score: 1 };
  }
}

function pumpValue(v, me, c, hint) {
  const p = hint.p || 0;
  const t = hint.t || 0;
  const opposing = c.attacking
    ? opponentCreatures(v, me).filter((x) => x.blocking === c.iid)
    : (() => { const a = opponentCreatures(v, me).find((x) => x.iid === c.blocking); return a ? [a] : []; })();

  if (!opposing.length) return c.attacking ? p * 0.6 : -1; // unblocked: extra damage only

  const incoming = opposing.reduce((n, x) => n + power(v, x), 0);
  const survivesNow = toughness(v, c) - c.damage > incoming;
  const survivesAfter = toughness(v, c) + t - c.damage > incoming;
  const killsNow = opposing.some((x) => power(v, c) >= toughness(v, x) - x.damage);
  const killsAfter = opposing.some((x) => power(v, c) + p >= toughness(v, x) - x.damage);

  let score = 0;
  if (!survivesNow && survivesAfter) score += creatureValue(v, c);
  if (!killsNow && killsAfter) score += creatureValue(v, opposing[0]);
  return score > 0 ? score : -1;
}

// ------------------------------------------------------- land choice ----

function chooseLand(v, me, landActions) {
  const mine = v.players[me];
  const produced = {};
  for (const c of mine.battlefield) if (c.produces) for (const col of c.produces) produced[col] = (produced[col] || 0) + 1;

  // Count the coloured pips our hand is asking for, weighted towards cheap cards.
  const need = {};
  for (const c of mine.hand) {
    const d = cardDef(c);
    if (!d.cost) continue;
    const weight = 1 / (1 + manaValue(d.cost));
    for (const ch of d.cost.toUpperCase()) {
      if ('WUBRG'.includes(ch)) need[ch] = (need[ch] || 0) + weight;
    }
  }

  return bestBy(landActions, (a) => {
    const card = mine.hand.find((c) => c.iid === a.iid);
    const colours = cardDef(card).produces || [];
    let s = 0;
    for (const col of colours) s += (need[col] || 0) * 3 - (produced[col] || 0) * 0.8;
    return s;
  }) || landActions[0];
}

// ------------------------------------------------------------ combat ----

/** The block the defender would most like to make against one attacker. */
function bestBlockAgainst(v, defenderId, attacker, blockers) {
  let best = { blocker: null, gain: 0 };
  for (const b of blockers) {
    if (!blockLegal(v, attacker, b)) continue;
    if (has(v, attacker, 'menace')) continue; // single blocks are illegal
    const aDies = power(v, b) >= toughness(v, attacker) - attacker.damage || has(v, b, 'deathtouch');
    const bDies = power(v, attacker) >= toughness(v, b) - b.damage || has(v, attacker, 'deathtouch');
    const prevented = has(v, attacker, 'trample')
      ? Math.max(0, power(v, attacker) - toughness(v, b))
      : power(v, attacker);
    const gain = (aDies ? creatureValue(v, attacker) : 0) - (bDies ? creatureValue(v, b) : 0) + prevented * 0.35;
    if (gain > best.gain) best = { blocker: b, gain, aDies, bDies };
  }
  return best;
}

export function chooseAttackers(v, me) {
  const them = 1 - me;
  const candidates = myCreatures(v, me).filter((c) => !c.tapped && (!c.summoningSick || has(v, c, 'haste')) && !has(v, c, 'defender'));
  if (!candidates.length) return [];

  const blockers = untapped(v.players[them]);
  const theirLife = v.players[them].life;
  const threat = incomingThreat(v, me);
  const myLife = v.players[me].life;
  const underPressure = threat >= myLife - 2;

  // If everything can swing for lethal past their blockers, do it.
  const unblockableDamage = candidates
    .filter((c) => !blockers.some((b) => blockLegal(v, c, b)))
    .reduce((n, c) => n + power(v, c), 0);
  const totalDamage = candidates.reduce((n, c) => n + power(v, c), 0);
  if (unblockableDamage >= theirLife) return candidates.filter((c) => power(v, c) > 0).map((c) => c.iid);
  if (totalDamage >= theirLife + blockers.reduce((n, b) => n + toughness(v, b), 0)) {
    return candidates.map((c) => c.iid);
  }

  const chosen = [];
  const available = blockers.slice();
  for (const a of candidates.sort((x, y) => power(v, y) - power(v, x))) {
    if (power(v, a) <= 0) continue;
    const block = bestBlockAgainst(v, them, a, available);

    let score;
    if (!block.blocker) {
      // Unblocked: raw damage, worth more as they get low.
      score = power(v, a) * (theirLife <= 8 ? 1.2 : 0.8);
    } else if (block.gain <= 0) {
      score = power(v, a) * 0.8; // they would not want that block
    } else {
      score = (block.bDies ? creatureValue(v, block.blocker) : 0) - (block.aDies ? creatureValue(v, a) : 0);
    }

    // Holding back matters when we might die next turn.
    if (underPressure && !has(v, a, 'vigilance')) score -= creatureValue(v, a) * 0.6;

    if (score > 0) {
      chosen.push(a.iid);
      if (block.blocker) available.splice(available.indexOf(block.blocker), 1);
    }
  }
  return chosen;
}

export function chooseBlockers(v, me) {
  const them = 1 - me;
  const attackers = v.combat.attackers
    .map((iid) => findCardInView(v, iid))
    .filter((c) => c && c.zone === 'battlefield');
  const blockers = untapped(v.players[me]);
  const blocks = {};
  if (!attackers.length || !blockers.length) return blocks;

  const available = blockers.slice();
  const incoming = attackers.reduce((n, a) => n + power(v, a), 0);
  const myLife = v.players[me].life;
  let mustPrevent = incoming - myLife + 1; // damage we have to stop to survive

  // Deal with the scariest attackers first.
  const ordered = attackers.slice().sort((a, b) => power(v, b) - power(v, a));

  for (const a of ordered) {
    if (!available.length) break;
    const legal = available.filter((b) => blockLegal(v, a, b));
    if (!legal.length) continue;

    if (has(v, a, 'menace')) {
      if (legal.length < 2) continue;
      const pair = legal.slice().sort((x, y) => creatureValue(v, x) - creatureValue(v, y)).slice(0, 2);
      const totalPower = pair.reduce((n, b) => n + power(v, b), 0);
      const kills = totalPower >= toughness(v, a) - a.damage;
      const cost = pair.reduce((n, b) => n + (power(v, a) >= toughness(v, b) ? creatureValue(v, b) : 0), 0);
      if ((kills && creatureValue(v, a) >= cost) || mustPrevent >= power(v, a)) {
        for (const b of pair) { blocks[b.iid] = a.iid; available.splice(available.indexOf(b), 1); }
        mustPrevent -= power(v, a);
      }
      continue;
    }

    const best = bestBlockAgainst(v, me, a, legal);
    const needChump = mustPrevent >= power(v, a) && mustPrevent > 0;

    if (best.blocker && best.gain > 0) {
      blocks[best.blocker.iid] = a.iid;
      available.splice(available.indexOf(best.blocker), 1);
      mustPrevent -= has(v, a, 'trample') ? Math.max(0, power(v, a) - toughness(v, best.blocker)) : power(v, a);
    } else if (needChump) {
      // Losing a creature beats losing the game.
      const chump = bestBy(legal, (b) => -creatureValue(v, b));
      if (chump) {
        blocks[chump.iid] = a.iid;
        available.splice(available.indexOf(chump), 1);
        mustPrevent -= has(v, a, 'trample') ? Math.max(0, power(v, a) - toughness(v, chump)) : power(v, a);
      }
    }
  }

  return blocks;
}

// ------------------------------------------------------------- driver ----

/**
 * Decide what to do. `actions` is the legal-action list for this AI, which is
 * derived only from its own hand and the public board.
 */
/** Keep a hand with two to five lands; otherwise ship it back. */
export function chooseMulligan(v, me, actions) {
  const hand = v.players[me].hand;
  const lands = hand.filter(isLand).length;
  const mulligansTaken = v.mulliganCounts[me];
  const size = hand.length - mulligansTaken;
  const canMulligan = actions.some((a) => a.type === 'mulligan');

  const low = 2;
  const high = size <= 6 ? 4 : 5;
  if (canMulligan && mulligansTaken < 2 && (lands < low || lands > high)) return { type: 'mulligan' };

  // Keeping: bottom the least useful cards.
  const keep = actions.find((a) => a.type === 'keep');
  const need = keep.bottomCount;
  if (!need) return { type: 'keep', bottom: [] };

  const flooded = lands > 3;
  const ranked = hand.slice().sort((a, b) => junkScore(b) - junkScore(a));
  function junkScore(c) {
    const d = cardDef(c);
    if (isLand(c)) return flooded ? 10 : -10;
    return manaValue(d.cost); // shed the top of the curve first
  }
  return { type: 'keep', bottom: ranked.slice(0, need).map((c) => c.iid) };
}

export function chooseAction(v, me, actions) {
  if (!actions.length) return null;

  if (actions.some((a) => a.type === 'keep')) return chooseMulligan(v, me, actions);

  const declare = actions.find((a) => a.type === 'declare_attackers');
  if (declare) return { type: 'declare_attackers', attackers: chooseAttackers(v, me) };

  const block = actions.find((a) => a.type === 'declare_blockers');
  if (block) return { type: 'declare_blockers', blocks: chooseBlockers(v, me) };

  const choose = actions.find((a) => a.type === 'choose_targets');
  if (choose) {
    const source = v.awaiting.pending;
    const hint = (source && source.spec && source.spec.ai) || {};
    const picked = pickTargets(v, me, choose.specs, choose.options, hint);
    return { type: 'choose_targets', targets: picked || choose.options.map((o) => o[0]) };
  }

  // Priority: land first, then the best-scoring spell, otherwise pass.
  const lands = actions.filter((a) => a.type === 'play_land');
  if (lands.length) return chooseLand(v, me, lands);

  let best = null;
  for (const a of actions) {
    if (a.type !== 'cast') continue;
    const result = scoreCast(v, me, a);
    if (result.score > 0 && (!best || result.score > best.score)) {
      best = { score: result.score, action: { type: 'cast', iid: a.iid, targets: result.targets || [] } };
    }
  }
  if (best) return best.action;

  return { type: 'pass' };
}

export { boardScore };
