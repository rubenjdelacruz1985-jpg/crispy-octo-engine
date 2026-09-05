// A small, hand-picked set of real Magic: The Gathering cards.
//
// This is unofficial fan content — not approved or endorsed by Wizards of
// the Coast. Magic: The Gathering is a trademark of Wizards of the Coast LLC.
// Card names and rules text belong to Wizards; card art is fetched live from
// Scryfall at display time (see scryfall.js) rather than copied into this
// repository, and is never bundled, sold, or redistributed.
//
// Only cards whose full printed rules text is a straightforward match for an
// effect this engine already implements are included here — a card is only
// "in" once it plays correctly, not just because it has a picture. That's a
// much smaller set than "every card Scryfall knows about," and it stays
// small on purpose: showing a card's art is easy, but nothing here recreates
// the layers system, replacement effects, or the thousands of one-off
// templates the real card pool uses, so this only ever covers a curated
// subset of simple, vanilla-shaped cards.
//
// Every id is prefixed `real_` so it can never collide with Spellforge's own
// original cards, and every definition carries `real: true` plus the exact
// Scryfall name to fetch art for.

import { register } from './registry.js';
import { dealDamage, destroy, bounce, draw, counterSpell, pump, resolveTarget } from './effects.js';

const T = {
  creature: (scope = 'any', label) => ({ kind: 'creature', scope, label: label || 'target creature' }),
  any: () => ({ kind: 'any', scope: 'any', label: 'any target' }),
  spell: () => ({ kind: 'spell', scope: 'any', label: 'target spell' }),
};
const first = (ctx, g) => resolveTarget(g, ctx.targets[0]);

const REAL_LANDS = [
  ['real_plains', 'Plains', 'W'],
  ['real_island', 'Island', 'U'],
  ['real_swamp', 'Swamp', 'B'],
  ['real_mountain', 'Mountain', 'R'],
  ['real_forest', 'Forest', 'G'],
].map(([id, name, colour]) => ({
  id, name, cost: '', types: ['Land'], subtypes: [name], colour,
  produces: [colour], text: `{T}: Add ${colour}.`,
  real: true, scryfallName: name,
}));

const REAL_CARDS = [
  {
    id: 'real_serra_angel', name: 'Serra Angel', cost: '3WW', colour: 'W',
    types: ['Creature'], subtypes: ['Angel'], power: 4, toughness: 4,
    keywords: ['flying', 'vigilance'], text: 'Flying, vigilance',
    real: true, scryfallName: 'Serra Angel',
  },
  {
    id: 'real_wall_of_swords', name: 'Wall of Swords', cost: '1W', colour: 'W',
    types: ['Creature'], subtypes: ['Wall'], power: 0, toughness: 5,
    keywords: ['flying', 'defender'], text: 'Defender, flying',
    real: true, scryfallName: 'Wall of Swords',
  },
  {
    id: 'real_counterspell', name: 'Counterspell', cost: 'UU', colour: 'U',
    types: ['Instant'], subtypes: [], text: 'Counter target spell.',
    targets: [T.spell()], ai: { kind: 'counter' },
    resolve: (g, ctx) => counterSpell(g, resolveTarget(g, ctx.targets[0])),
    real: true, scryfallName: 'Counterspell',
  },
  {
    id: 'real_unsummon', name: 'Unsummon', cost: 'U', colour: 'U',
    types: ['Instant'], subtypes: [], text: "Return target creature to its owner's hand.",
    targets: [T.creature('any')], ai: { kind: 'bounce' },
    resolve: (g, ctx) => bounce(g, first(ctx, g)),
    real: true, scryfallName: 'Unsummon',
  },
  {
    id: 'real_divination', name: 'Divination', cost: '2U', colour: 'U',
    types: ['Sorcery'], subtypes: [], text: 'Draw two cards.',
    ai: { kind: 'draw', n: 2 },
    resolve: (g, ctx) => draw(g, ctx.controller, 2),
    real: true, scryfallName: 'Divination',
  },
  {
    id: 'real_air_elemental', name: 'Air Elemental', cost: '3UU', colour: 'U',
    types: ['Creature'], subtypes: ['Elemental'], power: 4, toughness: 4,
    keywords: ['flying'], text: 'Flying',
    real: true, scryfallName: 'Air Elemental',
  },
  {
    id: 'real_murder', name: 'Murder', cost: '1BB', colour: 'B',
    types: ['Instant'], subtypes: [], text: 'Destroy target creature.',
    targets: [T.creature('any')], ai: { kind: 'destroy' },
    resolve: (g, ctx) => destroy(g, first(ctx, g)),
    real: true, scryfallName: 'Murder',
  },
  {
    id: 'real_lightning_bolt', name: 'Lightning Bolt', cost: 'R', colour: 'R',
    types: ['Instant'], subtypes: [], text: 'Lightning Bolt deals 3 damage to any target.',
    targets: [T.any()], ai: { kind: 'damage', amount: 3 },
    resolve: (g, ctx) => dealDamage(g, resolveTarget(g, ctx.targets[0]), 3, ctx.source),
    real: true, scryfallName: 'Lightning Bolt',
  },
  {
    id: 'real_shock', name: 'Shock', cost: 'R', colour: 'R',
    types: ['Instant'], subtypes: [], text: 'Shock deals 2 damage to any target.',
    targets: [T.any()], ai: { kind: 'damage', amount: 2 },
    resolve: (g, ctx) => dealDamage(g, resolveTarget(g, ctx.targets[0]), 2, ctx.source),
    real: true, scryfallName: 'Shock',
  },
  {
    id: 'real_giant_growth', name: 'Giant Growth', cost: 'G', colour: 'G',
    types: ['Instant'], subtypes: [], text: 'Target creature gets +3/+3 until end of turn.',
    targets: [T.creature('any')], ai: { kind: 'pump', p: 3, t: 3 },
    resolve: (g, ctx) => pump(g, first(ctx, g), 3, 3),
    real: true, scryfallName: 'Giant Growth',
  },
  {
    id: 'real_llanowar_elves', name: 'Llanowar Elves', cost: 'G', colour: 'G',
    types: ['Creature'], subtypes: ['Elf', 'Druid'], power: 1, toughness: 1,
    text: '{T}: Add {G}.', produces: ['G'],
    real: true, scryfallName: 'Llanowar Elves',
  },
  {
    id: 'real_grizzly_bears', name: 'Grizzly Bears', cost: '1G', colour: 'G',
    types: ['Creature'], subtypes: ['Bear'], power: 2, toughness: 2, text: '',
    real: true, scryfallName: 'Grizzly Bears',
  },
];

export const REAL_CARDS_ALL = register([...REAL_LANDS, ...REAL_CARDS]);

export const REAL_DECKS = {
  izzet_tempo_real: {
    id: 'izzet_tempo_real',
    name: 'Izzet Tempo (real cards)',
    colours: ['U', 'R'],
    blurb: 'Real Magic cards: counter their spell, bolt their face, draw more cards. Unofficial fan build.',
    cards: [
      ['real_island', 10], ['real_mountain', 8],
      ['real_counterspell', 4], ['real_unsummon', 4], ['real_divination', 3],
      ['real_air_elemental', 3], ['real_lightning_bolt', 4], ['real_shock', 4],
    ],
  },
  selesnya_growth_real: {
    id: 'selesnya_growth_real',
    name: 'Selesnya Growth (real cards)',
    colours: ['G', 'W'],
    blurb: 'Real Magic cards: ramp into big creatures and win fights with a trick in hand. Unofficial fan build.',
    cards: [
      ['real_forest', 10], ['real_plains', 10],
      ['real_llanowar_elves', 4], ['real_grizzly_bears', 4], ['real_giant_growth', 4],
      ['real_wall_of_swords', 4], ['real_serra_angel', 4],
    ],
  },
};
