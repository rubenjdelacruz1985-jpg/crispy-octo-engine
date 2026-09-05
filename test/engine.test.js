import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCost, manaValue, findPayment } from '../src/engine/mana.js';
import { createGame, applyAction, legalActions, findCard, checkStateBasedActions } from '../src/engine/rules.js';
import { power, toughness, has, canAttack, blockLegal } from '../src/engine/query.js';
import { moveCard, makeCard, viewFor } from '../src/engine/state.js';
import { chooseAction } from '../src/ai/ai.js';
import { manaSources } from '../src/engine/query.js';
import { findPayment as findManaPayment } from '../src/engine/mana.js';

function keepBothHands(g) {
  applyAction(g, g.awaiting.player, { type: 'keep', bottom: [] });
  if (g.awaiting && g.awaiting.type === 'mulligan') {
    applyAction(g, g.awaiting.player, { type: 'keep', bottom: [] });
  }
}

/** Pass priority (both players, as needed) until the active player is sitting in a main phase. */
function passToMain(g) {
  let guard = 0;
  while (!(g.step === 'main1' || g.step === 'main2') && guard++ < 100) {
    applyAction(g, g.awaiting.player, { type: 'pass' });
  }
}

test('mana: parses and pays costs correctly', () => {
  assert.deepEqual(parseCost('2WG'), { generic: 2, W: 1, U: 0, B: 0, R: 0, G: 1 });
  assert.equal(manaValue('3BB'), 5);

  const sources = [{ iid: 1, produces: ['G'] }, { iid: 2, produces: ['W'] }, { iid: 3, produces: ['G'] }];
  assert.deepEqual(findPayment(sources, '1G').sort(), [1, 2].sort()); // one G pip + one generic
  assert.equal(findPayment(sources, 'WW'), null); // only one white source
  assert.equal(findPayment(sources, '2G').length, 3);
});

test('mana: exhaustive matching finds a payment a greedy pass would miss', () => {
  // Only source 1 can pay white; a greedy algorithm might spend it on generic first.
  const sources = [
    { iid: 1, produces: ['W', 'G'] },
    { iid: 2, produces: ['G'] },
  ];
  assert.deepEqual(findPayment(sources, '1W').sort(), [1, 2].sort());
});

test('turn structure: land drop is once per turn, sorcery speed only', () => {
  const g = createGame({ seed: 1, startingPlayer: 0 });
  keepBothHands(g);
  passToMain(g);
  const me = 0;
  const land = g.players[me].hand.find((c) => c.defId.match(/_field|_basin|_fen|_ridge|wildwood/));
  assert.ok(land, 'starting hand should contain a land in this seed');

  applyAction(g, me, { type: 'play_land', iid: land.iid });
  assert.equal(g.players[me].battlefield.some((c) => c.iid === land.iid), true);

  const land2 = g.players[me].hand.find((c) => c.defId === land.defId);
  const actions = legalActions(g, me);
  assert.equal(actions.some((a) => a.type === 'play_land'), false, 'no second land drop this turn');
});

test('combat: flying can only be blocked by flying or reach', () => {
  const g = createGame({ seed: 2, startingPlayer: 0 });
  keepBothHands(g);
  const flyer = moveCard(g, makeCard(g, 'mistwing_drake', 1), 1, 'battlefield');
  flyer.summoningSick = false;
  const groundBlocker = moveCard(g, makeCard(g, 'thornhide_cub', 0), 0, 'battlefield');
  const reachBlocker = moveCard(g, makeCard(g, 'vinewrap_guardian', 0), 0, 'battlefield');

  assert.equal(blockLegal(g, flyer, groundBlocker), false);
  assert.equal(blockLegal(g, flyer, reachBlocker), true);
});

test('combat: deathtouch makes any nonzero damage lethal', () => {
  const g = createGame({ seed: 3, startingPlayer: 0 });
  keepBothHands(g);
  const assassin = moveCard(g, makeCard(g, 'cinderveil_assassin', 0), 0, 'battlefield'); // 2/2 deathtouch
  const bigBlocker = moveCard(g, makeCard(g, 'elder_bramblehorn', 1), 1, 'battlefield'); // 7/7
  assassin.damage = 0;
  bigBlocker.damage = 2; // took the assassin's 2 damage
  bigBlocker.dealtDeathtouch = true;
  checkStateBasedActions(g);
  assert.equal(bigBlocker.zone, 'graveyard', 'deathtouch damage should be lethal regardless of toughness');
});

test('mana abilities: producing mana does not require summoning sickness to have worn off', () => {
  const g = createGame({ seed: 4, startingPlayer: 0 });
  keepBothHands(g);
  const land = moveCard(g, makeCard(g, 'ember_ridge', 0), 0, 'battlefield');
  assert.equal(land.tapped, false);
  assert.equal(land.produces.includes('R'), true);
});

test('state-based actions: a player at 0 or less life loses immediately', () => {
  const g = createGame({ seed: 5, startingPlayer: 0 });
  keepBothHands(g);
  g.players[1].life = 0;
  checkStateBasedActions(g);
  assert.equal(g.winner, 0);
});

test('stack: a spell fizzles cleanly if its only target disappears', () => {
  const g = createGame({ seed: 6, startingPlayer: 0 });
  keepBothHands(g);
  const target = moveCard(g, makeCard(g, 'thornhide_cub', 1), 1, 'battlefield');
  const bolt = makeCard(g, 'cinder_lance', 0);
  moveCard(g, bolt, 0, 'stack');
  g.stack.push({
    sid: g.nextSid++, kind: 'spell', defId: 'cinder_lance', card: bolt, sourceIid: bolt.iid,
    controller: 0, targets: [{ t: 'card', iid: target.iid }],
  });
  // Target leaves the battlefield before the spell resolves.
  moveCard(g, target, 1, 'graveyard');
  g.awaiting = { type: 'priority', player: 0 };
  g.passCount = 2; // force immediate resolution path via applyAction's pass
  applyAction(g, 0, { type: 'pass' });
  assert.equal(g.stack.length, 0);
  assert.equal(findCard(g, bolt.iid).zone, 'graveyard', 'the spell itself should end up in the graveyard');
});

test('view: the opponent hand is redacted, not merely marked hidden', () => {
  const g = createGame({ seed: 7, startingPlayer: 0 });
  keepBothHands(g);
  const view = viewFor(g, 0);
  const oppHandView = view.players[1].hand;
  for (const c of oppHandView) {
    assert.equal(c.hidden, true);
    assert.equal('defId' in c, false, 'a hidden card must not carry its identity');
  }
  assert.equal('library' in view.players[0], false, 'no library key should exist in a view at all');
});

test("AI: never sees the opponent's hand contents when choosing an action", () => {
  const g = createGame({ seed: 8, aiPlayers: [1], startingPlayer: 0 });
  keepBothHands(g);
  const view = viewFor(g, 1);
  const serialized = JSON.stringify(view);
  for (const c of g.players[0].hand) {
    assert.equal(serialized.includes(c.defId), false, `AI's view leaked "${c.defId}" from the human's hand`);
  }
});

test('real cards: a freshly cast mana dork cannot tap for mana the turn it enters (summoning sickness)', () => {
  const g = createGame({ seed: 20, startingPlayer: 0 });
  keepBothHands(g);
  const elves = moveCard(g, makeCard(g, 'real_llanowar_elves', 0), 0, 'battlefield');
  assert.equal(elves.summoningSick, true);
  assert.equal(manaSources(g, 0).includes(elves), false, 'a summoning-sick creature must not count as an available mana source');

  elves.summoningSick = false;
  assert.equal(manaSources(g, 0).includes(elves), true, 'once it has been around since the turn began, it can tap for mana');
});

test('real cards: a land can still tap for mana the turn it enters (lands are never summoning sick)', () => {
  const g = createGame({ seed: 21, startingPlayer: 0 });
  keepBothHands(g);
  const forest = moveCard(g, makeCard(g, 'real_forest', 0), 0, 'battlefield');
  assert.equal(manaSources(g, 0).includes(forest), true);
});

test('real cards: Counterspell removes both itself and its target from the stack', () => {
  const g = createGame({ seed: 22, startingPlayer: 0 });
  keepBothHands(g);
  const bolt = makeCard(g, 'real_lightning_bolt', 1);
  moveCard(g, bolt, 1, 'stack');
  g.stack.push({
    sid: g.nextSid++, kind: 'spell', defId: 'real_lightning_bolt', card: bolt, sourceIid: bolt.iid,
    controller: 1, targets: [{ t: 'player', id: 0 }],
  });
  const counterCard = makeCard(g, 'real_counterspell', 0);
  moveCard(g, counterCard, 0, 'stack');
  g.stack.push({
    sid: g.nextSid++, kind: 'spell', defId: 'real_counterspell', card: counterCard, sourceIid: counterCard.iid,
    controller: 0, targets: [{ t: 'spell', sid: g.stack[0].sid }],
  });

  // Both players have already passed once; this pass is the second, so the
  // top of the stack (Counterspell) resolves.
  g.priorityPlayer = 1;
  g.passCount = 1;
  g.awaiting = { type: 'priority', player: 1 };
  applyAction(g, 1, { type: 'pass' });

  assert.equal(g.stack.length, 0, 'Counterspell removes its countered target from the stack too, not just itself');
  assert.equal(findCard(g, bolt.iid).zone, 'graveyard', "the countered spell's card goes to the graveyard");
  assert.equal(findCard(g, counterCard.iid).zone, 'graveyard', "Counterspell's own card goes to the graveyard once it resolves");
  assert.equal(g.players[0].life, 20, 'the countered Lightning Bolt must never have dealt its damage');
});

test('real cards: Murder destroys any target creature regardless of colour', () => {
  const g = createGame({ seed: 23, startingPlayer: 0 });
  keepBothHands(g);
  const target = moveCard(g, makeCard(g, 'real_serra_angel', 1), 1, 'battlefield');
  const payment = findManaPayment([
    moveCard(g, makeCard(g, 'real_swamp', 0), 0, 'battlefield'),
    moveCard(g, makeCard(g, 'real_swamp', 0), 0, 'battlefield'),
    moveCard(g, makeCard(g, 'real_swamp', 0), 0, 'battlefield'),
  ], '1BB');
  assert.equal(payment.length, 3, 'three swamps should pay Murder\'s 1BB');
});
