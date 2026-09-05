// Starter decks. Forty cards each with seventeen lands — quick games, real curve.

export const DECKS = {
  ember_vanguard: {
    id: 'ember_vanguard',
    name: 'Ember Vanguard',
    colours: ['R', 'W'],
    blurb: 'Cheap creatures, haste and burn. Get them to zero before they set up.',
    cards: [
      ['ember_ridge', 9],
      ['sunlit_field', 8],
      ['ember_scout', 2],
      ['lantern_acolyte', 2],
      ['ravine_bandit', 3],
      ['watch_recruit', 3],
      ['ridge_charger', 3],
      ['dawnbreak_paladin', 2],
      ['firebrand_ritualist', 2],
      ['shieldwall_captain', 1],
      ['cinder_lance', 3],
      ['reckless_dash', 1],
      ['molten_rupture', 1],
    ],
  },

  tidefall_requiem: {
    id: 'tidefall_requiem',
    name: 'Tidefall Requiem',
    colours: ['U', 'B'],
    blurb: 'Answer everything, then win in the air. Patient and mean.',
    cards: [
      ['tidal_basin', 9],
      ['bleak_fen', 8],
      ['grave_whisper', 2],
      ['tidecaller_adept', 2],
      ['gravecrawl_ghoul', 2],
      ['cinderveil_assassin', 2],
      ['scholar_of_tides', 2],
      ['mistwing_drake', 2],
      ['windlash_siren', 2],
      ['nightshade_reaper', 1],
      ['leviathan_whelp', 1],
      ['rot_bolt', 2],
      ['consume_hope', 2],
      ['undertow', 1],
      ['arcane_rebuttal', 1],
      ['drain_vitality', 1],
    ],
  },

  wildwood_surge: {
    id: 'wildwood_surge',
    name: 'Wildwood Surge',
    colours: ['G', 'W'],
    blurb: 'Bigger creatures than yours, and tricks to win every fight.',
    cards: [
      ['wildwood', 10],
      ['sunlit_field', 7],
      ['thornhide_cub', 3],
      ['thicket_prowler', 3],
      ['vinewrap_guardian', 3],
      ['grovekeeper', 2],
      ['elder_bramblehorn', 1],
      ['watch_recruit', 2],
      ['skyward_sentinel', 2],
      ['shieldwall_captain', 1],
      ['verdant_surge', 2],
      ['wild_bite', 2],
      ['grove_blessing', 1],
      ['sunspear_rebuke', 1],
    ],
  },
};

export const DECK_IDS = Object.keys(DECKS);

export function deckSize(id) {
  return DECKS[id].cards.reduce((n, [, count]) => n + count, 0);
}
