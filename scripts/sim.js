// Self-play harness. Runs full AI-vs-AI games and reports what happened.
//   node scripts/sim.js [games] [deck0] [deck1]

import { createGame, legalActions, applyAction, viewFor, summarize } from '../src/engine/rules.js';
import { chooseAction } from '../src/ai/ai.js';
import { DECK_IDS } from '../src/engine/decks.js';

export function playGame(seed, deck0, deck1, { maxTurns = 140, trace = false } = {}) {
  const g = createGame({ seed, deck0, deck1, aiPlayers: [0, 1], names: ['A', 'B'], startingPlayer: seed % 2 });
  let steps = 0;
  // Both sides mulligan with the AI's own judgement before the game proper starts.
  while (g.awaiting && g.awaiting.type === 'mulligan' && steps < 20) {
    steps++;
    const me = g.awaiting.player;
    const view = viewFor(g, me);
    const action = chooseAction(view, me, legalActions(g, me));
    applyAction(g, me, action);
  }
  while (g.winner === null && g.turn <= maxTurns && steps < 20000) {
    steps++;
    if (!g.awaiting) throw new Error(`Engine stalled with no decision pending at ${summarize(g)}`);
    const me = g.awaiting.player;
    const actions = legalActions(g, me);
    if (!actions.length) throw new Error(`No legal actions for ${me} at ${summarize(g)} (${g.awaiting.type})`);
    const view = viewFor(g, me);
    const action = chooseAction(view, me, actions) || { type: 'pass' };
    if (trace) console.log(`  ${summarize(g)} p${me} ${action.type}`);
    applyAction(g, me, action);
  }
  return { g, steps, turns: g.turn, winner: g.winner };
}

const games = Number(process.argv[2] || 50);
const d0 = process.argv[3];
const d1 = process.argv[4];

if (import.meta.url === `file://${process.argv[1]}`) {
  const pairs = d0 && d1 ? [[d0, d1]] : [];
  if (!pairs.length) for (const a of DECK_IDS) for (const b of DECK_IDS) pairs.push([a, b]);

  for (const [a, b] of pairs) {
    let wins = [0, 0, 0]; // p0, p1, draw/timeout
    let totalTurns = 0;
    let failures = 0;
    let lastError = null;
    for (let i = 0; i < games; i++) {
      try {
        const r = playGame(i * 7919 + 13, a, b);
        totalTurns += r.turns;
        if (r.winner === null) wins[2]++;
        else wins[r.winner]++;
      } catch (e) {
        failures++;
        if (!lastError) lastError = e;
      }
    }
    const pct = (n) => `${Math.round((n / games) * 100)}%`;
    console.log(
      `${a.padEnd(18)} vs ${b.padEnd(18)}  p0 ${pct(wins[0])}  p1 ${pct(wins[1])}  ` +
      `unfinished ${wins[2]}  avg turns ${(totalTurns / Math.max(1, games - failures)).toFixed(1)}` +
      (failures ? `  ERRORS ${failures}` : '')
    );
    if (lastError) {
      console.log('  first error:', lastError.message);
      console.log(lastError.stack.split('\n').slice(1, 5).join('\n'));
    }
  }
}
