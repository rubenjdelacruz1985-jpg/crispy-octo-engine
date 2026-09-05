// The rules engine: turn structure, priority, the stack, and combat.
//
// The engine is a pure state machine. It never asks anyone anything — it sets
// `g.awaiting` to say whose decision it needs, and waits for applyAction().

import './cards.js'; // registers the card pool
import { cardDef, cardName } from './registry.js';
import {
  makeRng, shuffle, makeCard, makePlayer, moveCard, findCard, log, viewFor,
} from './state.js';
import {
  power, toughness, has, isCreature, isLand, isInstant, isSorcery,
  canAttack, blockLegal, isDead, manaSources,
} from './query.js';
import { findPayment, manaValue } from './mana.js';
import { dealDamage, destroy, draw, resolveTarget } from './effects.js';
import { DECKS } from './decks.js';

export const STEPS = [
  'untap', 'upkeep', 'draw', 'main1', 'begin_combat',
  'declare_attackers', 'declare_blockers', 'combat_damage',
  'end_combat', 'main2', 'end', 'cleanup',
];

export const STEP_LABELS = {
  untap: 'Untap', upkeep: 'Upkeep', draw: 'Draw',
  main1: 'Main phase 1', begin_combat: 'Begin combat',
  declare_attackers: 'Declare attackers', declare_blockers: 'Declare blockers',
  combat_damage: 'Combat damage', end_combat: 'End of combat',
  main2: 'Main phase 2', end: 'End step', cleanup: 'Cleanup',
};

const MAIN_STEPS = new Set(['main1', 'main2']);
const STARTING_HAND = 7;
const MAX_MULLIGANS = 3;

// ---------------------------------------------------------------- setup ----

export function createGame(opts = {}) {
  const {
    deck0 = 'ember_vanguard',
    deck1 = 'tidefall_requiem',
    names = ['You', 'Claude'],
    seed = Math.floor(Math.random() * 2 ** 31),
    aiPlayers = [1],
    startingPlayer = null,
  } = opts;

  const rng = makeRng(seed);
  const g = {
    seed,
    rng,
    turn: 1,
    nextId: 1,
    step: 'main1',
    activePlayer: 0,
    priorityPlayer: 0,
    passCount: 0,
    awaiting: null,
    stack: [],
    nextSid: 1,
    pendingTriggers: [],
    combat: freshCombat(),
    log: [],
    winner: null,
    players: [makePlayer(0, names[0], deck0), makePlayer(1, names[1], deck1)],
  };

  for (const p of g.players) p.isAI = aiPlayers.includes(p.id);

  for (const p of g.players) {
    const list = DECKS[p.deckList];
    if (!list) throw new Error(`Unknown deck: ${p.deckList}`);
    p.deckName = list.name;
    for (const [defId, count] of list.cards) {
      for (let i = 0; i < count; i++) p.library.push(makeCard(g, defId, p.id));
    }
    shuffle(p.library, rng);
    for (const c of p.library) c.zone = 'library';
  }

  g.firstPlayer = startingPlayer === null ? (rng() < 0.5 ? 0 : 1) : startingPlayer;
  g.activePlayer = g.firstPlayer;

  for (const p of g.players) {
    for (let i = 0; i < STARTING_HAND; i++) moveCard(g, p.library[p.library.length - 1], p.id, 'hand');
  }

  log(g, `${g.players[g.firstPlayer].name} goes first.`);
  g.mulliganCounts = [0, 0];
  g.mulliganDone = [false, false];
  g.awaiting = { type: 'mulligan', player: g.firstPlayer };
  return g;
}

function freshCombat() {
  return { attackers: [], blocks: {}, declaredAttackers: false, declaredBlockers: false, damageStage: 0 };
}

export { viewFor };

// ------------------------------------------------------------ turn flow ----

function beginStep(g, step) {
  g.step = step;
  g.passCount = 0;

  switch (step) {
    case 'untap': {
      const p = g.players[g.activePlayer];
      for (const c of p.battlefield) {
        c.tapped = false;
        c.summoningSick = false;
      }
      p.landsPlayedThisTurn = 0;
      log(g, `--- Turn ${g.turn}: ${p.name} ---`);
      return nextStep(g); // no priority during untap
    }
    case 'draw': {
      const skip = g.turn === 1 && g.activePlayer === g.firstPlayer;
      if (!skip) draw(g, g.activePlayer, 1);
      return openPriority(g);
    }
    case 'declare_attackers': {
      g.combat = freshCombat();
      const possible = g.players[g.activePlayer].battlefield.filter((c) => isCreature(c) && canAttack(g, c));
      if (possible.length === 0) {
        g.combat.declaredAttackers = true;
        return beginStep(g, 'end_combat');
      }
      g.awaiting = { type: 'attackers', player: g.activePlayer };
      return;
    }
    case 'declare_blockers': {
      if (g.combat.attackers.length === 0) return beginStep(g, 'end_combat');
      g.awaiting = { type: 'blockers', player: 1 - g.activePlayer };
      return;
    }
    case 'combat_damage': {
      const anyFirstStrike = combatCreatures(g).some((c) => has(g, c, 'first strike') || has(g, c, 'double strike'));
      if (anyFirstStrike) {
        dealCombatDamage(g, true);
        g.combat.damageStage = 1;
      } else {
        dealCombatDamage(g, false);
        g.combat.damageStage = 2;
      }
      return openPriority(g);
    }
    case 'end_combat': {
      for (const c of allPermanents(g)) {
        c.attacking = false;
        c.blocking = null;
        c.blockedBy = [];
        c.wasBlocked = false;
      }
      g.combat = freshCombat();
      return openPriority(g);
    }
    case 'cleanup': {
      const p = g.players[g.activePlayer];
      // Discard down to seven, then wipe damage and until-end-of-turn effects.
      while (p.hand.length > 7) {
        const worst = p.hand[p.hand.length - 1];
        moveCard(g, worst, p.id, 'graveyard');
        log(g, `${p.name} discards ${cardName(worst)} at cleanup.`);
      }
      for (const c of allPermanents(g)) {
        c.damage = 0;
        c.tempPower = 0;
        c.tempToughness = 0;
        c.tempKeywords = [];
        c.dealtDeathtouch = false;
      }
      g.turn += 1;
      g.activePlayer = 1 - g.activePlayer;
      return beginStep(g, 'untap');
    }
    default:
      return openPriority(g);
  }
}

function nextStep(g) {
  // Combat damage runs twice when first strike is involved.
  if (g.step === 'combat_damage' && g.combat.damageStage === 1) {
    dealCombatDamage(g, false);
    g.combat.damageStage = 2;
    return openPriority(g);
  }
  const i = STEPS.indexOf(g.step);
  return beginStep(g, STEPS[Math.min(i + 1, STEPS.length - 1)]);
}

function openPriority(g) {
  g.priorityPlayer = g.activePlayer;
  g.passCount = 0;
  g.awaiting = { type: 'priority', player: g.priorityPlayer };
}

/** Run everything the engine can do on its own, then stop for a decision. */
function advance(g) {
  let guard = 0;
  while (guard++ < 5000) {
    checkStateBasedActions(g);
    if (g.winner !== null) {
      g.awaiting = null;
      return g;
    }
    if (g.pendingTriggers.length && !g.awaiting) {
      if (putTriggersOnStack(g)) continue;
    }
    if (g.awaiting) return g;
    // Nothing pending and nobody to ask: the step machine already set awaiting,
    // so reaching here means we can safely move on.
    nextStep(g);
  }
  throw new Error('Rules engine failed to settle — this is a bug.');
}

// -------------------------------------------------------------- actions ----

/**
 * Everything `playerId` may legally do right now.
 *
 * Cast actions come back without targets; `specs` and `options` describe what
 * still needs choosing, so the UI can prompt and the AI can enumerate.
 */
export function legalActions(g, playerId) {
  const out = [];
  if (g.winner !== null || !g.awaiting) return out;
  const aw = g.awaiting;
  if (aw.player !== playerId) return out;

  if (aw.type === 'mulligan') {
    const toBottom = Math.min(g.mulliganCounts[playerId], g.players[playerId].hand.length);
    return [
      { type: 'keep', bottomCount: toBottom },
      ...(g.mulliganCounts[playerId] < MAX_MULLIGANS ? [{ type: 'mulligan' }] : []),
    ];
  }

  if (aw.type === 'attackers' || aw.type === 'blockers') {
    // Declarations are submitted whole, not enumerated one creature at a time.
    return [{ type: aw.type === 'attackers' ? 'declare_attackers' : 'declare_blockers' }];
  }

  if (aw.type === 'choose_targets') {
    return [{ type: 'choose_targets', specs: aw.specs, options: aw.specs.map((s) => legalTargets(g, s, aw.player)) }];
  }

  if (aw.type !== 'priority') return out;

  const p = g.players[playerId];
  out.push({ type: 'pass' });

  const sorcerySpeed = g.activePlayer === playerId && MAIN_STEPS.has(g.step) && g.stack.length === 0;

  for (const card of p.hand) {
    const d = cardDef(card);

    if (isLand(card)) {
      if (sorcerySpeed && p.landsPlayedThisTurn < p.maxLandsPerTurn) {
        out.push({ type: 'play_land', iid: card.iid });
      }
      continue;
    }

    const instantSpeed = isInstant(card);
    if (!instantSpeed && !sorcerySpeed) continue;

    const payment = findPayment(manaSources(g, playerId), d.cost);
    if (!payment) continue;

    const specs = d.targets || [];
    const options = specs.map((s) => legalTargets(g, s, playerId, card));
    if (options.some((o) => o.length === 0)) continue; // a spell needs legal targets

    out.push({ type: 'cast', iid: card.iid, specs, options, cost: d.cost });
  }

  return out;
}

/** Target references that satisfy `spec` for `controllerId`. */
export function legalTargets(g, spec, controllerId, sourceCard = null) {
  const refs = [];
  const creatures = [];
  for (const p of g.players) for (const c of p.battlefield) if (isCreature(c)) creatures.push(c);

  const matchesCreature = (c) => {
    switch (spec.scope) {
      case 'yours': return c.controller === controllerId;
      case 'opponent': return c.controller !== controllerId;
      case 'attacking': return !!c.attacking;
      case 'blocking': return c.blocking !== null && c.blocking !== undefined;
      case 'attacking_or_blocking': return !!c.attacking || (c.blocking !== null && c.blocking !== undefined);
      default: return true;
    }
  };

  if (spec.kind === 'creature' || spec.kind === 'any') {
    for (const c of creatures) if (matchesCreature(c)) refs.push({ t: 'card', iid: c.iid });
  }
  if (spec.kind === 'player' || spec.kind === 'any') {
    for (const p of g.players) {
      if (spec.scope === 'opponent' && p.id === controllerId) continue;
      if (spec.scope === 'yours' && p.id !== controllerId) continue;
      refs.push({ t: 'player', id: p.id });
    }
  }
  if (spec.kind === 'spell') {
    for (const s of g.stack) {
      if (s.kind !== 'spell') continue;
      if (sourceCard && s.sourceIid === sourceCard.iid) continue;
      refs.push({ t: 'spell', sid: s.sid });
    }
  }
  return refs;
}

export function applyAction(g, playerId, action) {
  if (g.winner !== null) return g;
  const aw = g.awaiting;
  if (!aw || aw.player !== playerId) throw new Error(`Not ${g.players[playerId].name}'s decision right now.`);

  switch (action.type) {
    case 'pass': requirePriority(g, playerId); doPass(g); break;
    case 'play_land': requirePriority(g, playerId); doPlayLand(g, playerId, action.iid); break;
    case 'cast': requirePriority(g, playerId); doCast(g, playerId, action.iid, action.targets || []); break;
    case 'declare_attackers': doDeclareAttackers(g, playerId, action.attackers || []); break;
    case 'declare_blockers': doDeclareBlockers(g, playerId, action.blocks || {}); break;
    case 'choose_targets': doChooseTriggerTargets(g, playerId, action.targets || []); break;
    case 'mulligan': doMulligan(g, playerId); break;
    case 'keep': doKeep(g, playerId, action.bottom || []); break;
    case 'concede':
      g.winner = 1 - playerId;
      log(g, `${g.players[playerId].name} concedes.`);
      break;
    default:
      throw new Error(`Unknown action: ${action.type}`);
  }
  return advance(g);
}

function doMulligan(g, playerId) {
  if (g.awaiting.type !== 'mulligan') throw new Error('Not the mulligan step.');
  if (g.mulliganCounts[playerId] >= MAX_MULLIGANS) throw new Error('No mulligans left.');
  const p = g.players[playerId];
  for (const c of p.hand.slice()) moveCard(g, c, playerId, 'library');
  shuffle(p.library, g.rng);
  for (let i = 0; i < STARTING_HAND; i++) moveCard(g, p.library[p.library.length - 1], playerId, 'hand');
  g.mulliganCounts[playerId] += 1;
  log(g, `${p.name} mulligans to ${STARTING_HAND - g.mulliganCounts[playerId]}.`);
  g.awaiting = { type: 'mulligan', player: playerId };
}

function doKeep(g, playerId, bottom) {
  if (g.awaiting.type !== 'mulligan') throw new Error('Not the mulligan step.');
  const p = g.players[playerId];
  const need = Math.min(g.mulliganCounts[playerId], p.hand.length);
  if (bottom.length !== need) throw new Error(`Put ${need} card${need === 1 ? '' : 's'} on the bottom.`);
  for (const iid of bottom) {
    const card = p.hand.find((c) => c.iid === iid);
    if (!card) throw new Error('That card is not in your hand.');
    moveCard(g, card, playerId, 'library');
    // moveCard appends, which is the top of the library — move it to the bottom.
    p.library.pop();
    p.library.unshift(card);
  }
  g.mulliganDone[playerId] = true;
  log(g, `${p.name} keeps ${p.hand.length}.`);

  const other = 1 - playerId;
  if (!g.mulliganDone[other]) {
    g.awaiting = { type: 'mulligan', player: other };
    return;
  }
  g.awaiting = null;
  beginStep(g, 'untap');
}

function requirePriority(g, playerId) {
  if (g.awaiting.type !== 'priority') throw new Error('You do not have priority.');
  if (g.priorityPlayer !== playerId) throw new Error('You do not have priority.');
}

function doPass(g) {
  g.passCount += 1;
  if (g.passCount >= 2) {
    if (g.stack.length > 0) {
      resolveTop(g);
      g.passCount = 0;
      g.priorityPlayer = g.activePlayer;
      g.awaiting = { type: 'priority', player: g.priorityPlayer };
    } else {
      g.awaiting = null;
      nextStep(g);
    }
  } else {
    g.priorityPlayer = 1 - g.priorityPlayer;
    g.awaiting = { type: 'priority', player: g.priorityPlayer };
  }
}

function doPlayLand(g, playerId, iid) {
  const p = g.players[playerId];
  const card = p.hand.find((c) => c.iid === iid);
  if (!card || !isLand(card)) throw new Error('That is not a land in your hand.');
  if (!(MAIN_STEPS.has(g.step) && g.activePlayer === playerId && g.stack.length === 0)) {
    throw new Error('Lands can only be played in your main phase with an empty stack.');
  }
  if (p.landsPlayedThisTurn >= p.maxLandsPerTurn) throw new Error('No land drops left this turn.');
  p.landsPlayedThisTurn += 1;
  moveCard(g, card, playerId, 'battlefield');
  card.summoningSick = false; // lands can tap for mana immediately
  log(g, `${p.name} plays ${cardName(card)}.`);
  // Playing a land is a special action: no priority change, no stack.
  g.awaiting = { type: 'priority', player: playerId };
  g.passCount = 0;
}

function doCast(g, playerId, iid, targets) {
  const p = g.players[playerId];
  const card = p.hand.find((c) => c.iid === iid);
  if (!card) throw new Error('That card is not in your hand.');
  const d = cardDef(card);
  if (isLand(card)) throw new Error('Lands are played, not cast.');

  const sorcerySpeed = g.activePlayer === playerId && MAIN_STEPS.has(g.step) && g.stack.length === 0;
  if (!isInstant(card) && !sorcerySpeed) throw new Error(`${d.name} can only be cast at sorcery speed.`);

  const specs = d.targets || [];
  if (targets.length !== specs.length) throw new Error(`${d.name} needs ${specs.length} target(s).`);
  specs.forEach((spec, i) => {
    const legal = legalTargets(g, spec, playerId, card);
    const ok = legal.some((r) => sameTarget(r, targets[i]));
    if (!ok) throw new Error(`Illegal target for ${d.name}.`);
  });

  const payment = findPayment(manaSources(g, playerId), d.cost);
  if (!payment) throw new Error(`Not enough mana for ${d.name}.`);
  for (const sid of payment) {
    const src = findCard(g, sid);
    src.tapped = true;
  }

  moveCard(g, card, playerId, 'stack');
  card.zone = 'stack';

  g.stack.push({
    sid: g.nextSid++,
    kind: 'spell',
    defId: card.defId,
    card,
    sourceIid: card.iid,
    controller: playerId,
    targets: targets.map((t) => ({ ...t })),
  });
  log(g, `${p.name} casts ${d.name}${describeTargets(g, targets)}.`);

  // The caster keeps priority after casting.
  g.passCount = 0;
  g.priorityPlayer = playerId;
  g.awaiting = { type: 'priority', player: playerId };
}

function sameTarget(a, b) {
  if (!a || !b || a.t !== b.t) return false;
  if (a.t === 'card') return a.iid === b.iid;
  if (a.t === 'player') return a.id === b.id;
  if (a.t === 'spell') return a.sid === b.sid;
  return false;
}

function describeTargets(g, targets) {
  if (!targets || !targets.length) return '';
  const names = targets.map((t) => {
    if (t.t === 'player') return g.players[t.id].name;
    if (t.t === 'card') { const c = findCard(g, t.iid); return c ? cardName(c) : 'something'; }
    if (t.t === 'spell') { const s = g.stack.find((x) => x.sid === t.sid); return s ? cardName(s.defId) : 'a spell'; }
    return 'something';
  });
  return ` targeting ${names.join(' and ')}`;
}

// ---------------------------------------------------------------- stack ----

function resolveTop(g) {
  const item = g.stack.pop();
  if (!item) return;
  const d = cardDef(item.defId);

  // A spell or ability with no legal targets left does nothing.
  const specs = item.kind === 'trigger' ? (item.spec.targets || []) : (d.targets || []);
  if (specs.length) {
    const anyLegal = item.targets.some((t) => resolveTarget(g, t) !== null);
    if (!anyLegal) {
      log(g, `${d.name} fizzles — its targets are gone.`);
      if (item.card) moveCard(g, item.card, item.card.owner, 'graveyard');
      return;
    }
  }

  const ctx = {
    controller: item.controller,
    targets: item.targets,
    source: item.card || findCard(g, item.sourceIid),
  };

  if (item.kind === 'trigger') {
    item.spec.resolve(g, ctx);
    return;
  }

  const isPermanent = ['Creature', 'Artifact', 'Enchantment'].some((t) => d.types.includes(t));
  if (isPermanent) {
    moveCard(g, item.card, item.controller, 'battlefield');
    log(g, `${d.name} enters the battlefield.`);
    if (d.onEnter) {
      g.pendingTriggers.push({
        defId: item.defId, controller: item.controller, sourceIid: item.card.iid,
        kind: 'enter', spec: d.onEnter,
      });
    }
  } else {
    if (d.resolve) d.resolve(g, ctx);
    moveCard(g, item.card, item.card.owner, 'graveyard');
  }
}

/**
 * Move queued triggers onto the stack. Returns true if the caller should loop
 * again (a trigger needs targets chosen first).
 */
function putTriggersOnStack(g) {
  while (g.pendingTriggers.length) {
    const trig = g.pendingTriggers[0];
    const spec = trig.spec || cardDef(trig.defId)[trig.kind === 'death' ? 'onDeath' : 'onEnter'];
    const specs = spec.targets || [];

    if (specs.length) {
      const options = specs.map((s) => legalTargets(g, s, trig.controller));
      if (options.some((o) => o.length === 0)) {
        g.pendingTriggers.shift();
        log(g, `${cardName(trig.defId)}'s trigger has no legal targets and is removed.`);
        continue;
      }
      g.pendingTriggers.shift();
      g.awaiting = { type: 'choose_targets', player: trig.controller, specs, pending: { ...trig, spec } };
      return true;
    }

    g.pendingTriggers.shift();
    g.stack.push({
      sid: g.nextSid++, kind: 'trigger', defId: trig.defId, controller: trig.controller,
      sourceIid: trig.sourceIid, spec, targets: [], card: null,
    });
    log(g, `${cardName(trig.defId)} triggers.`);
    openPriority(g);
    return true;
  }
  return false;
}

function doChooseTriggerTargets(g, playerId, targets) {
  const aw = g.awaiting;
  if (aw.type !== 'choose_targets') throw new Error('Nothing to target right now.');
  const { specs, pending } = aw;
  if (targets.length !== specs.length) throw new Error('Wrong number of targets.');
  specs.forEach((spec, i) => {
    const legal = legalTargets(g, spec, playerId);
    if (!legal.some((r) => sameTarget(r, targets[i]))) throw new Error('Illegal target.');
  });

  g.stack.push({
    sid: g.nextSid++, kind: 'trigger', defId: pending.defId, controller: pending.controller,
    sourceIid: pending.sourceIid, spec: pending.spec, targets: targets.map((t) => ({ ...t })), card: null,
  });
  log(g, `${cardName(pending.defId)} triggers${describeTargets(g, targets)}.`);
  g.awaiting = null;
  openPriority(g);
}

// --------------------------------------------------------------- combat ----

function allPermanents(g) {
  return [...g.players[0].battlefield, ...g.players[1].battlefield];
}

function combatCreatures(g) {
  const out = [];
  for (const iid of g.combat.attackers) {
    const a = findCard(g, iid);
    if (a && a.zone === 'battlefield') out.push(a);
  }
  for (const c of allPermanents(g)) if (c.blocking !== null && c.blocking !== undefined) out.push(c);
  return out;
}

function doDeclareAttackers(g, playerId, attackerIids) {
  if (g.awaiting.type !== 'attackers') throw new Error('Not the declare-attackers step.');
  const p = g.players[playerId];
  for (const iid of attackerIids) {
    const c = p.battlefield.find((x) => x.iid === iid);
    if (!c) throw new Error('That creature is not yours.');
    if (!canAttack(g, c)) throw new Error(`${cardName(c)} cannot attack.`);
  }
  for (const iid of attackerIids) {
    const c = findCard(g, iid);
    c.attacking = true;
    if (!has(g, c, 'vigilance')) c.tapped = true;
  }
  g.combat.attackers = attackerIids.slice();
  g.combat.declaredAttackers = true;

  if (attackerIids.length) {
    log(g, `${p.name} attacks with ${attackerIids.map((i) => cardName(findCard(g, i))).join(', ')}.`);
  } else {
    log(g, `${p.name} does not attack.`);
  }

  g.awaiting = null;
  if (attackerIids.length === 0) return beginStep(g, 'end_combat');
  return openPriority(g);
}

function doDeclareBlockers(g, playerId, blocks) {
  if (g.awaiting.type !== 'blockers') throw new Error('Not the declare-blockers step.');

  // blocks: { blockerIid: attackerIid }
  const byAttacker = {};
  for (const [blockerIid, attackerIid] of Object.entries(blocks)) {
    const blocker = g.players[playerId].battlefield.find((c) => c.iid === Number(blockerIid));
    const attacker = findCard(g, Number(attackerIid));
    if (!blocker) throw new Error('That blocker is not yours.');
    if (!attacker || !attacker.attacking) throw new Error('That creature is not attacking.');
    if (!blockLegal(g, attacker, blocker)) throw new Error(`${cardName(blocker)} cannot block ${cardName(attacker)}.`);
    (byAttacker[attackerIid] ||= []).push(Number(blockerIid));
  }

  // Menace: blocked by two or more creatures, or not at all.
  for (const [attackerIid, blockerIids] of Object.entries(byAttacker)) {
    const attacker = findCard(g, Number(attackerIid));
    if (has(g, attacker, 'menace') && blockerIids.length === 1) {
      throw new Error(`${cardName(attacker)} has menace and must be blocked by two or more creatures.`);
    }
  }

  for (const [attackerIid, blockerIids] of Object.entries(byAttacker)) {
    const attacker = findCard(g, Number(attackerIid));
    attacker.blockedBy = blockerIids.slice();
    attacker.wasBlocked = true;
    for (const bid of blockerIids) findCard(g, bid).blocking = attacker.iid;
  }

  g.combat.blocks = byAttacker;
  g.combat.declaredBlockers = true;

  const count = Object.keys(blocks).length;
  log(g, count ? `${g.players[playerId].name} blocks with ${count} creature${count === 1 ? '' : 's'}.`
    : `${g.players[playerId].name} does not block.`);

  g.awaiting = null;
  return openPriority(g);
}

function dealCombatDamage(g, firstStrikeStep) {
  const defenderId = 1 - g.activePlayer;
  const defender = g.players[defenderId];

  const dealsNow = (c) => {
    const fs = has(g, c, 'first strike');
    const ds = has(g, c, 'double strike');
    return firstStrikeStep ? (fs || ds) : (ds || (!fs && !ds));
  };

  const damage = []; // collected, then applied at once so combat is simultaneous

  for (const iid of g.combat.attackers) {
    const a = findCard(g, iid);
    if (!a || a.zone !== 'battlefield' || !dealsNow(a)) continue;
    let remaining = power(g, a);
    if (remaining <= 0) continue;

    const blockers = (a.blockedBy || []).map((b) => findCard(g, b)).filter((b) => b && b.zone === 'battlefield');

    if (!a.wasBlocked) {
      damage.push([defender, remaining, a]);
      continue;
    }

    // Assign lethal damage in the order blockers were declared.
    for (const b of blockers) {
      if (remaining <= 0) break;
      const needed = has(g, a, 'deathtouch') ? 1 : Math.max(1, toughness(g, b) - b.damage);
      const assign = Math.min(remaining, needed);
      damage.push([b, assign, a]);
      remaining -= assign;
    }
    if (remaining > 0 && has(g, a, 'trample')) damage.push([defender, remaining, a]);
  }

  for (const c of allPermanents(g)) {
    if (c.blocking === null || c.blocking === undefined) continue;
    if (c.zone !== 'battlefield' || !dealsNow(c)) continue;
    const attacker = findCard(g, c.blocking);
    if (!attacker || attacker.zone !== 'battlefield') continue;
    const p = power(g, c);
    if (p > 0) damage.push([attacker, p, c]);
  }

  if (damage.length) log(g, firstStrikeStep ? 'First-strike damage.' : 'Combat damage.');
  for (const [target, amount, source] of damage) dealDamage(g, target, amount, source);
}

// -------------------------------------------------- state-based actions ----

export function checkStateBasedActions(g) {
  let repeat = true;
  let guard = 0;
  while (repeat && guard++ < 50) {
    repeat = false;

    for (const p of g.players) {
      if (p.life <= 0 && g.winner === null) {
        g.winner = 1 - p.id;
        log(g, `${p.name} is at ${p.life} life and loses.`);
      }
      if (p.hasDrawnFromEmpty && g.winner === null) {
        g.winner = 1 - p.id;
        log(g, `${p.name} has no cards left to draw and loses.`);
      }
    }
    if (g.winner !== null) return;

    for (const p of g.players) {
      for (const c of p.battlefield.slice()) {
        if (isCreature(c) && isDead(g, c)) {
          destroy(g, c, 'destroyed');
          repeat = true;
        }
      }
    }
  }
}

// -------------------------------------------------------------- helpers ----

export function summarize(g) {
  return `T${g.turn} ${g.step} | ${g.players.map((p) => `${p.name} ${p.life}`).join(' vs ')}`;
}

export { findCard, power, toughness, has, isCreature, isLand, isInstant, isSorcery, manaValue, cardDef, cardName };
