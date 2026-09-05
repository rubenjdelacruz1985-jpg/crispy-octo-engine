// The card pool.
//
// These are original cards. The rules they run on are the familiar ones —
// stack, priority, phases, combat keywords — but every name, cost and line of
// text here is written for this project.
//
// A definition looks like:
//   id, name, cost, types, subtypes, power/toughness, keywords, text
//   targets:  what the spell or trigger needs before it goes on the stack
//   resolve:  (g, ctx) => void, run when it resolves
//   onEnter:  triggered ability when a permanent enters the battlefield
//   onDeath:  triggered ability when a creature dies
//   anthem:   a static buff other permanents you control get

import { register } from './registry.js';
import {
  dealDamage, destroy, exileCard, bounce, draw, gainLife, loseLife,
  pump, addCounters, counterSpell, fight, discardRandom, resolveTarget,
} from './effects.js';
import { power } from './query.js';

// Target shorthands.
const T = {
  creature: (scope = 'any', label) => ({ kind: 'creature', scope, label: label || 'target creature' }),
  any: () => ({ kind: 'any', scope: 'any', label: 'any target' }),
  player: (scope = 'any') => ({ kind: 'player', scope, label: 'target player' }),
  spell: () => ({ kind: 'spell', scope: 'any', label: 'target spell' }),
};

const first = (ctx, g) => resolveTarget(g, ctx.targets[0]);
const second = (ctx, g) => resolveTarget(g, ctx.targets[1]);

const LANDS = [
  ['sunlit_field', 'Sunlit Field', 'W'],
  ['tidal_basin', 'Tidal Basin', 'U'],
  ['bleak_fen', 'Bleak Fen', 'B'],
  ['ember_ridge', 'Ember Ridge', 'R'],
  ['wildwood', 'Wildwood', 'G'],
].map(([id, name, colour]) => ({
  id,
  name,
  cost: '',
  types: ['Land'],
  subtypes: [],
  colour,
  produces: [colour],
  text: `Tap: Add ${colour}.`,
}));

const WHITE = [
  {
    id: 'lantern_acolyte', name: 'Lantern Acolyte', cost: 'W', colour: 'W',
    types: ['Creature'], subtypes: ['Human', 'Cleric'], power: 1, toughness: 2,
    keywords: ['lifelink'], text: 'Lifelink',
  },
  {
    id: 'watch_recruit', name: 'Watch Recruit', cost: '1W', colour: 'W',
    types: ['Creature'], subtypes: ['Human', 'Soldier'], power: 2, toughness: 2,
    keywords: ['vigilance'], text: 'Vigilance',
  },
  {
    id: 'dawnbreak_paladin', name: 'Dawnbreak Paladin', cost: '2W', colour: 'W',
    types: ['Creature'], subtypes: ['Human', 'Knight'], power: 3, toughness: 3,
    keywords: ['first strike'], text: 'First strike',
  },
  {
    id: 'skyward_sentinel', name: 'Skyward Sentinel', cost: '2W', colour: 'W',
    types: ['Creature'], subtypes: ['Griffin'], power: 2, toughness: 3,
    keywords: ['flying'], text: 'Flying',
  },
  {
    id: 'shieldwall_captain', name: 'Shieldwall Captain', cost: '3W', colour: 'W',
    types: ['Creature'], subtypes: ['Human', 'Soldier'], power: 3, toughness: 4,
    keywords: ['vigilance'], anthem: { power: 1, toughness: 0, others: true },
    text: 'Vigilance. Other creatures you control get +1/+0.',
  },
  {
    id: 'gallant_charge', name: 'Gallant Charge', cost: 'W', colour: 'W',
    types: ['Instant'], subtypes: [], text: 'Target creature gets +2/+2 until end of turn.',
    targets: [T.creature('any')],
    ai: { kind: 'pump', p: 2, t: 2 },
    resolve: (g, ctx) => pump(g, first(ctx, g), 2, 2),
  },
  {
    id: 'sunspear_rebuke', name: 'Sunspear Rebuke', cost: '1W', colour: 'W',
    types: ['Instant'], subtypes: [], text: 'Exile target attacking or blocking creature.',
    targets: [T.creature('attacking_or_blocking', 'target attacking or blocking creature')],
    ai: { kind: 'exile' },
    resolve: (g, ctx) => exileCard(g, first(ctx, g)),
  },
  {
    id: 'rally_the_line', name: 'Rally the Line', cost: '2W', colour: 'W',
    types: ['Sorcery'], subtypes: [], text: 'Creatures you control get +1/+1 until end of turn.',
    ai: { kind: 'mass_pump', p: 1, t: 1 },
    resolve: (g, ctx) => {
      for (const c of g.players[ctx.controller].battlefield) {
        if (c.defId && CARD_IS_CREATURE(c)) pump(g, c, 1, 1);
      }
    },
  },
];

const BLUE = [
  {
    id: 'tidecaller_adept', name: 'Tidecaller Adept', cost: '1U', colour: 'U',
    types: ['Creature'], subtypes: ['Merfolk', 'Wizard'], power: 1, toughness: 3,
    keywords: [], text: '',
  },
  {
    id: 'scholar_of_tides', name: 'Scholar of Tides', cost: '2U', colour: 'U',
    types: ['Creature'], subtypes: ['Human', 'Wizard'], power: 1, toughness: 3,
    text: 'When Scholar of Tides enters the battlefield, draw a card.',
    onEnter: { resolve: (g, ctx) => draw(g, ctx.controller, 1) },
  },
  {
    id: 'mistwing_drake', name: 'Mistwing Drake', cost: '2U', colour: 'U',
    types: ['Creature'], subtypes: ['Drake'], power: 2, toughness: 3,
    keywords: ['flying'], text: 'Flying',
  },
  {
    id: 'windlash_siren', name: 'Windlash Siren', cost: '3U', colour: 'U',
    types: ['Creature'], subtypes: ['Siren'], power: 3, toughness: 3,
    keywords: ['flying'], text: 'Flying',
  },
  {
    id: 'leviathan_whelp', name: 'Leviathan Whelp', cost: '4U', colour: 'U',
    types: ['Creature'], subtypes: ['Serpent'], power: 5, toughness: 5,
    text: '',
  },
  {
    id: 'undertow', name: 'Undertow', cost: 'U', colour: 'U',
    types: ['Instant'], subtypes: [], text: "Return target creature to its owner's hand.",
    targets: [T.creature('any')],
    ai: { kind: 'bounce' },
    resolve: (g, ctx) => bounce(g, first(ctx, g)),
  },
  {
    id: 'arcane_rebuttal', name: 'Arcane Rebuttal', cost: '1U', colour: 'U',
    types: ['Instant'], subtypes: [], text: 'Counter target spell.',
    targets: [T.spell()],
    ai: { kind: 'counter' },
    resolve: (g, ctx) => counterSpell(g, resolveTarget(g, ctx.targets[0])),
  },
  {
    id: 'deep_study', name: 'Deep Study', cost: '2U', colour: 'U',
    types: ['Instant'], subtypes: [], text: 'Draw two cards.',
    ai: { kind: 'draw', n: 2 },
    resolve: (g, ctx) => draw(g, ctx.controller, 2),
  },
];

const BLACK = [
  {
    id: 'grave_whisper', name: 'Grave Whisper', cost: 'B', colour: 'B',
    types: ['Creature'], subtypes: ['Spirit'], power: 1, toughness: 1,
    text: 'When Grave Whisper dies, each opponent loses 1 life.',
    onDeath: { resolve: (g, ctx) => loseLife(g, 1 - ctx.controller, 1) },
  },
  {
    id: 'gravecrawl_ghoul', name: 'Gravecrawl Ghoul', cost: '1B', colour: 'B',
    types: ['Creature'], subtypes: ['Zombie'], power: 2, toughness: 2,
    keywords: ['menace'], text: 'Menace (This creature can be blocked only by two or more creatures.)',
  },
  {
    id: 'cinderveil_assassin', name: 'Cinderveil Assassin', cost: '2B', colour: 'B',
    types: ['Creature'], subtypes: ['Human', 'Assassin'], power: 2, toughness: 2,
    keywords: ['deathtouch'], text: 'Deathtouch',
  },
  {
    id: 'nightshade_reaper', name: 'Nightshade Reaper', cost: '4B', colour: 'B',
    types: ['Creature'], subtypes: ['Demon'], power: 4, toughness: 4,
    keywords: ['flying', 'lifelink'], text: 'Flying, lifelink',
  },
  {
    id: 'rot_bolt', name: 'Rot Bolt', cost: '1B', colour: 'B',
    types: ['Instant'], subtypes: [], text: 'Target creature gets -3/-3 until end of turn.',
    targets: [T.creature('any')],
    ai: { kind: 'debuff', p: -3, t: -3 },
    resolve: (g, ctx) => pump(g, first(ctx, g), -3, -3),
  },
  {
    id: 'drain_vitality', name: 'Drain Vitality', cost: '2B', colour: 'B',
    types: ['Instant'], subtypes: [], text: 'Target player loses 2 life and you gain 2 life.',
    targets: [T.player('opponent')],
    ai: { kind: 'drain', n: 2 },
    resolve: (g, ctx) => {
      const p = resolveTarget(g, ctx.targets[0]);
      if (!p) return;
      loseLife(g, p.id, 2);
      gainLife(g, ctx.controller, 2);
    },
  },
  {
    id: 'consume_hope', name: 'Consume Hope', cost: '3B', colour: 'B',
    types: ['Sorcery'], subtypes: [], text: 'Destroy target creature.',
    targets: [T.creature('any')],
    ai: { kind: 'destroy' },
    resolve: (g, ctx) => destroy(g, first(ctx, g)),
  },
  {
    id: 'bone_harvest', name: 'Bone Harvest', cost: '2B', colour: 'B',
    types: ['Sorcery'], subtypes: [],
    text: 'Target player discards a card at random and loses 1 life.',
    targets: [T.player('opponent')],
    ai: { kind: 'discard' },
    resolve: (g, ctx) => {
      const p = resolveTarget(g, ctx.targets[0]);
      if (!p) return;
      discardRandom(g, p.id, 1, g.rng);
      loseLife(g, p.id, 1);
    },
  },
];

const RED = [
  {
    id: 'ember_scout', name: 'Ember Scout', cost: 'R', colour: 'R',
    types: ['Creature'], subtypes: ['Goblin', 'Scout'], power: 1, toughness: 1,
    keywords: ['haste'], text: 'Haste',
  },
  {
    id: 'ravine_bandit', name: 'Ravine Bandit', cost: '1R', colour: 'R',
    types: ['Creature'], subtypes: ['Human', 'Rogue'], power: 2, toughness: 1,
    text: '',
  },
  {
    id: 'firebrand_ritualist', name: 'Firebrand Ritualist', cost: '2R', colour: 'R',
    types: ['Creature'], subtypes: ['Human', 'Shaman'], power: 2, toughness: 2,
    text: 'When Firebrand Ritualist enters the battlefield, it deals 1 damage to any target.',
    onEnter: {
      ai: { kind: 'damage', amount: 1 },
      targets: [T.any()],
      resolve: (g, ctx) => dealDamage(g, resolveTarget(g, ctx.targets[0]), 1, ctx.source),
    },
  },
  {
    id: 'ridge_charger', name: 'Ridge Charger', cost: '2R', colour: 'R',
    types: ['Creature'], subtypes: ['Beast'], power: 3, toughness: 2,
    keywords: ['trample', 'haste'], text: 'Trample, haste',
  },
  {
    id: 'blaze_titan', name: 'Blaze Titan', cost: '5R', colour: 'R',
    types: ['Creature'], subtypes: ['Giant'], power: 6, toughness: 4,
    keywords: ['trample'], text: 'Trample',
  },
  {
    id: 'cinder_lance', name: 'Cinder Lance', cost: 'R', colour: 'R',
    types: ['Instant'], subtypes: [], text: 'Cinder Lance deals 2 damage to any target.',
    targets: [T.any()],
    ai: { kind: 'damage', amount: 2 },
    resolve: (g, ctx) => dealDamage(g, resolveTarget(g, ctx.targets[0]), 2, ctx.source),
  },
  {
    id: 'reckless_dash', name: 'Reckless Dash', cost: 'R', colour: 'R',
    types: ['Instant'], subtypes: [],
    text: 'Target creature gets +2/+0 and gains haste until end of turn.',
    targets: [T.creature('any')],
    ai: { kind: 'pump', p: 2, t: 0 },
    resolve: (g, ctx) => pump(g, first(ctx, g), 2, 0, ['haste']),
  },
  {
    id: 'molten_rupture', name: 'Molten Rupture', cost: '3R', colour: 'R',
    types: ['Sorcery'], subtypes: [], text: 'Molten Rupture deals 4 damage to any target.',
    targets: [T.any()],
    ai: { kind: 'damage', amount: 4 },
    resolve: (g, ctx) => dealDamage(g, resolveTarget(g, ctx.targets[0]), 4, ctx.source),
  },
];

const GREEN = [
  {
    id: 'thornhide_cub', name: 'Thornhide Cub', cost: 'G', colour: 'G',
    types: ['Creature'], subtypes: ['Bear'], power: 1, toughness: 2, text: '',
  },
  {
    id: 'thicket_prowler', name: 'Thicket Prowler', cost: '1G', colour: 'G',
    types: ['Creature'], subtypes: ['Cat'], power: 2, toughness: 2, text: '',
  },
  {
    id: 'vinewrap_guardian', name: 'Vinewrap Guardian', cost: '2G', colour: 'G',
    types: ['Creature'], subtypes: ['Treefolk'], power: 3, toughness: 3,
    keywords: ['reach'], text: 'Reach',
  },
  {
    id: 'grovekeeper', name: 'Grovekeeper', cost: '3G', colour: 'G',
    types: ['Creature'], subtypes: ['Elf', 'Warrior'], power: 4, toughness: 4,
    keywords: ['trample'], text: 'Trample',
  },
  {
    id: 'elder_bramblehorn', name: 'Elder Bramblehorn', cost: '5G', colour: 'G',
    types: ['Creature'], subtypes: ['Beast'], power: 7, toughness: 7,
    keywords: ['trample'], text: 'Trample',
  },
  {
    id: 'verdant_surge', name: 'Verdant Surge', cost: '1G', colour: 'G',
    types: ['Instant'], subtypes: [], text: 'Target creature gets +3/+3 until end of turn.',
    targets: [T.creature('any')],
    ai: { kind: 'pump', p: 3, t: 3 },
    resolve: (g, ctx) => pump(g, first(ctx, g), 3, 3),
  },
  {
    id: 'grove_blessing', name: 'Grove Blessing', cost: '2G', colour: 'G',
    types: ['Sorcery'], subtypes: [], text: 'Put two +1/+1 counters on target creature.',
    targets: [T.creature('yours', 'target creature you control')],
    ai: { kind: 'counters', n: 2 },
    resolve: (g, ctx) => addCounters(g, first(ctx, g), 2),
  },
  {
    id: 'wild_bite', name: 'Wild Bite', cost: '2G', colour: 'G',
    types: ['Sorcery'], subtypes: [],
    text: 'Target creature you control fights target creature an opponent controls.',
    targets: [T.creature('yours', 'target creature you control'), T.creature('opponent', 'target creature an opponent controls')],
    ai: { kind: 'fight' },
    resolve: (g, ctx) => fight(g, first(ctx, g), second(ctx, g)),
  },
];

export const CARDS = register([...LANDS, ...WHITE, ...BLUE, ...BLACK, ...RED, ...GREEN]);

function CARD_IS_CREATURE(card) {
  const d = CARDS[card.defId];
  return !!d && d.types.includes('Creature');
}

export const CARD_LIST = Object.values(CARDS);
export { power };
