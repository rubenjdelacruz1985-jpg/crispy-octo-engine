# Spellforge

A playable, browser-based trading card game with a full Magic-the-Gathering-style
rules engine — the stack, priority, phases, combat with keywords like flying,
trample, deathtouch and lifelink — plus an AI opponent you can play against.

The cards, names, and art here are all original. The rules they run on are the
familiar Magic rules (this project doesn't use Wizards of the Coast's card
database, since that's their copyright), but the mechanics themselves — stack,
priority, phases, combat — aren't anyone's property, so the game plays the same
way. A Scryfall-backed "real cards" mode is a natural follow-up if you ever want
one, kept separate from this original set.

## Playing it

```
npm start
```

Then open http://localhost:5173.

Pick a deck for yourself and one for Claude, mulligan if you don't like your
hand, and play. Claude never sees your hand or the order of either deck — it
decides everything from the same public information you'd have looking across
the table.

## How it's put together

```
src/engine/   the rules engine — pure state machine, no UI or AI knowledge
  mana.js       mana costs and payment (exhaustive matching, not greedy)
  registry.js   card definition lookup (breaks an import cycle)
  cards.js      the card pool: names, costs, text, resolve functions
  decks.js      three 40-card starter decks
  state.js      zones, card instances, and the redacted player "view"
  query.js      derived power/toughness/keywords (never stored directly)
  effects.js    damage, destroy, draw, pump, counters — effect primitives
  rules.js      turn structure, the stack, priority, combat, state-based actions

src/ai/
  ai.js         the opponent: board evaluation, targeting, combat math, mulligans

src/ui/
  app.js        renders from viewFor(game, HUMAN) — the same redacted snapshot
                the AI gets, so there's nothing in the DOM to read either

test/           engine unit tests (node --test)
scripts/sim.js  AI-vs-AI self-play harness for balance and regression checking
```

The engine is a state machine: it never asks a question directly, it sets
`game.awaiting` to say whose decision is needed and waits for `applyAction()`.
Both the human UI and the AI drive the game through the exact same
`legalActions()` / `applyAction()` API — the AI has no back door.

### Why the AI can't cheat

`viewFor(game, playerId)` produces the only thing either the UI or the AI ever
sees. A view has no `library` key at all, and an opponent's hand comes through
as `{ iid, hidden: true, owner, zone }` — the card's identity simply isn't in
the object. There's no hand-reading bug to introduce by accident, because the
information doesn't exist on the AI's side of the fence.

## Testing

```
npm test                              # engine unit tests
node scripts/sim.js 100                # 100 AI-vs-AI games per deck matchup
node scripts/sim.js 20 ember_vanguard wildwood_surge   # one matchup, 20 games
```

The self-play harness is what caught most of the real bugs during
development — running a couple hundred full games surfaces edge cases a
human playtester would take a lot longer to hit.
