// Game state: zones, card instances, and the redacted views handed to players.

import { CARDS } from './registry.js';

export const ZONES = ['library', 'hand', 'battlefield', 'graveyard', 'exile'];

export function makeRng(seed = Date.now()) {
  // Small deterministic PRNG so games can be replayed and tests can be stable.
  let s = seed >>> 0 || 1;
  return function rng() {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function makeCard(g, defId, owner) {
  const d = CARDS[defId];
  if (!d) throw new Error(`Unknown card definition: ${defId}`);
  return {
    iid: g.nextId++,
    defId,
    owner,
    controller: owner,
    zone: 'library',
    tapped: false,
    summoningSick: true,
    damage: 0,
    // Temporary modifiers, wiped during cleanup.
    tempPower: 0,
    tempToughness: 0,
    tempKeywords: [],
    // Permanent +1/+1 counters.
    counters: 0,
    attacking: false,
    blocking: null,
    blockedBy: [],
    produces: d.produces || null,
    dealtDeathtouch: false,
  };
}

export function makePlayer(id, name, deckList) {
  return {
    id,
    name,
    life: 20,
    library: [],
    hand: [],
    battlefield: [],
    graveyard: [],
    exile: [],
    landsPlayedThisTurn: 0,
    maxLandsPerTurn: 1,
    deckList,
    hasDrawnFromEmpty: false,
    isAI: false,
  };
}

export function opponentOf(g, playerId) {
  return g.players[1 - playerId];
}

/** Every card instance anywhere in the game, for id lookups. */
export function allCards(g) {
  const out = [];
  for (const p of g.players) for (const z of ZONES) out.push(...p[z]);
  return out;
}

export function findCard(g, iid) {
  for (const p of g.players) {
    for (const z of ZONES) {
      const c = p[z].find((x) => x.iid === iid);
      if (c) return c;
    }
  }
  // Cards that are mid-flight are held by their stack entry, not a zone array.
  for (const s of g.stack) if (s.card && s.card.iid === iid) return s.card;
  return null;
}

export function zoneOf(g, card) {
  return card.zone;
}

/** Move a card between zones, resetting the per-instance state that a new object gets. */
export function moveCard(g, card, toPlayerId, toZone) {
  // Cards on the stack live in their stack entry, so there is nothing to
  // splice out of a player's zone array.
  if (card.zone !== 'stack') {
    for (const p of g.players) {
      const arr = p[card.zone];
      if (!arr) continue;
      const i = arr.indexOf(card);
      if (i >= 0) { arr.splice(i, 1); break; }
    }
  }

  if (toZone !== 'battlefield') {
    card.tapped = false;
    card.damage = 0;
    card.tempPower = 0;
    card.tempToughness = 0;
    card.tempKeywords = [];
    card.counters = 0;
    card.attacking = false;
    card.blocking = null;
    card.blockedBy = [];
    card.dealtDeathtouch = false;
    card.controller = card.owner;
  }
  if (toZone === 'battlefield') {
    card.summoningSick = true;
    card.controller = toPlayerId;
  }

  card.zone = toZone;
  // A card on the stack is held by its stack entry, not by a player's zone.
  if (toZone !== 'stack') {
    const to = g.players[toZone === 'battlefield' ? toPlayerId : card.owner];
    to[toZone].push(card);
  }
  return card;
}

export function log(g, text) {
  g.log.push({ turn: g.turn, step: g.step, text });
  if (g.log.length > 400) g.log.shift();
}

/**
 * The slice of the game a single player is allowed to see.
 *
 * This is the only thing the AI ever receives, so it cannot read the human's
 * hand or either library even by accident — the information simply is not in
 * the object. The UI renders from the human's view for the same reason.
 */
export function viewFor(g, playerId) {
  const clonePublic = (c) => ({ ...c, hidden: false });
  const cloneHidden = (c) => ({ iid: c.iid, hidden: true, owner: c.owner, zone: c.zone });

  const players = g.players.map((p) => {
    const mine = p.id === playerId;
    return {
      id: p.id,
      name: p.name,
      life: p.life,
      isAI: p.isAI,
      landsPlayedThisTurn: p.landsPlayedThisTurn,
      maxLandsPerTurn: p.maxLandsPerTurn,
      hand: mine ? p.hand.map(clonePublic) : p.hand.map(cloneHidden),
      handCount: p.hand.length,
      battlefield: p.battlefield.map(clonePublic),
      graveyard: p.graveyard.map(clonePublic),
      exile: p.exile.map(clonePublic),
      librarySize: p.library.length,
      // Deliberately no `library` key: nobody sees the deck order.
    };
  });

  return {
    isView: true,
    viewer: playerId,
    turn: g.turn,
    step: g.step,
    activePlayer: g.activePlayer,
    priorityPlayer: g.priorityPlayer,
    awaiting: g.awaiting ? { ...g.awaiting } : null,
    stack: g.stack.map((s) => ({
      sid: s.sid,
      kind: s.kind,
      defId: s.defId,
      controller: s.controller,
      targets: s.targets ? s.targets.map((t) => ({ ...t })) : [],
    })),
    combat: {
      attackers: g.combat.attackers.slice(),
      blocks: JSON.parse(JSON.stringify(g.combat.blocks)),
      declaredAttackers: g.combat.declaredAttackers,
      declaredBlockers: g.combat.declaredBlockers,
    },
    winner: g.winner,
    mulliganCounts: g.mulliganCounts ? g.mulliganCounts.slice() : [0, 0],
    players,
    log: g.log.slice(-40),
  };
}

/** Look up a card inside a view (views have no library, so search the rest). */
export function findInView(v, iid) {
  for (const p of v.players) {
    for (const z of ['hand', 'battlefield', 'graveyard', 'exile']) {
      const c = p[z].find((x) => x.iid === iid);
      if (c) return c;
    }
  }
  return null;
}
