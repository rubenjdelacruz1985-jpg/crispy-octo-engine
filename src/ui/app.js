// Table UI.
//
// The screen is drawn from viewFor(game, HUMAN) — the same redacted snapshot
// the AI gets for itself. Your opponent's hand is not in the DOM at all, so
// there is nothing to read out of the page.

import {
  createGame, legalActions, applyAction, viewFor, legalTargets,
  STEPS, STEP_LABELS,
} from '../engine/rules.js';
import { DECKS, DECK_IDS } from '../engine/decks.js';
import { cardDef } from '../engine/registry.js';
import { power, toughness, has, isCreature, isLand, canAttack, blockLegal } from '../engine/query.js';
import { costSymbols } from '../engine/mana.js';
import { chooseAction } from '../ai/ai.js';
import { fetchCardImage } from './scryfall.js';
import { PROFILES, DEFAULT_PROFILE, profileById, quipFor } from './profiles.js';
import { speak, stopVoice, setMuted, isMuted } from './voice.js';
import { sfx, resume as resumeSfx, setMuted as setSfxMuted } from './sfx.js';

const HUMAN = 0;
const AI = 1;

let G = null;                 // authoritative game state
let V = null;                 // the human's view of it
let ui = { mode: 'idle' };
let settings = { autoPass: true, aiDelay: 700 };
let picks = { you: 'ember_vanguard', ai: 'tidefall_requiem', profile: DEFAULT_PROFILE.id };
let opponent = DEFAULT_PROFILE;   // the selected AI persona
let lastQuipAt = 0;               // throttle trash-talk
const lifePrev = {};              // last-seen life per player, for change pulses

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

// ------------------------------------------------------------- setup ----

function renderSetup() {
  renderProfilePicker();
  const heading = $('aiDeckHeading');
  if (heading) heading.textContent = `${profileById(picks.profile).name}'s deck`;
  for (const [listId, key] of [['deckListYou', 'you'], ['deckListAi', 'ai']]) {
    const wrap = $(listId);
    wrap.innerHTML = '';
    for (const id of DECK_IDS) {
      const d = DECKS[id];
      const b = el('button', `deck-option${picks[key] === id ? ' selected' : ''}`);
      const name = el('div', 'dname');
      name.append(el('span', null, d.name), pipRow(d.colours));
      b.append(name, el('div', 'dblurb', d.blurb));
      b.onclick = () => { picks[key] = id; renderSetup();

// Load with ?debug=1 to poke at the game from the console.
if (new URLSearchParams(location.search).get('debug')) {
  Object.defineProperty(window, 'spellforge', {
    get: () => ({ game: G, view: V, ui, tick, render }),
  });
} };
      wrap.append(b);
    }
  }
}

function pipRow(colours) {
  const row = el('span', 'pips');
  for (const c of colours) row.append(el('span', `pip ${c}`, c));
  return row;
}

function renderProfilePicker() {
  const wrap = $('profilePicker');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const p of PROFILES) {
    const b = el('button', `profile-card${picks.profile === p.id ? ' selected' : ''}`);
    b.append(el('span', 'pavatar', p.avatar));
    const meta = el('span', 'pmeta');
    const nameRow = el('span', 'pname-row');
    nameRow.append(el('span', 'pname', p.name), el('span', `ptier tier-${p.tier.toLowerCase()}`, p.tier));
    meta.append(nameRow, el('span', 'pblurb', p.blurb));
    b.append(meta);
    b.onclick = () => { picks.profile = p.id; renderSetup(); };
    wrap.append(b);
  }
}

function startGame() {
  settings.autoPass = $('optAutoPass').checked;
  settings.aiDelay = $('optFastAi').checked ? 160 : 700;
  opponent = profileById(picks.profile);
  stopVoice();
  resumeSfx(); // this click is the user gesture that unlocks Web Audio
  lastQuipAt = 0;
  delete lifePrev[HUMAN]; delete lifePrev[AI];
  G = createGame({
    deck0: picks.you,
    deck1: picks.ai,
    names: ['You', opponent.name],
    aiPlayers: [AI],
  });
  ui = { mode: 'idle' };
  $('setup').classList.add('hidden');
  $('table').classList.remove('hidden');
  $('overlay').classList.add('hidden');
  $('oppSpeech').classList.add('hidden');
  tick();
  // A greeting once the table is up (slight delay so it lands after the deal).
  setTimeout(() => maybeQuip('greet', { force: true }), 650);
}

// --------------------------------------------------------- game loop ----

function tick() {
  V = viewFor(G, HUMAN);
  render();

  if (G.winner !== null) return showGameOver();
  const aw = G.awaiting;
  if (!aw) return;

  if (aw.player === AI) {
    setTimeout(() => {
      if (!G || G.winner !== null || !G.awaiting || G.awaiting.player !== AI) return;
      const aiView = viewFor(G, AI);
      const actions = legalActions(G, AI);
      // Skill knob: a weaker persona sometimes just passes its priority (misses a
      // play) instead of taking the engine's best line. Only at priority, where
      // passing is always legal — never corrupts attackers/blockers/targets.
      let action;
      if (G.awaiting.type === 'priority' && Math.random() < (opponent.mistakeRate || 0)) {
        action = { type: 'pass' };
      } else {
        action = chooseAction(aiView, AI, actions) || { type: 'pass' };
      }
      const humanLifeBefore = G.players[HUMAN].life;
      try {
        applyAction(G, AI, action);
      } catch (err) {
        // Never let a bad AI choice wedge the game.
        console.warn('AI action rejected, passing instead:', action, err.message);
        try { applyAction(G, AI, { type: 'pass' }); } catch { /* nothing left to do */ }
      }
      // React to what just happened.
      if (G.players[HUMAN].life < humanLifeBefore) maybeQuip('damage');
      else if (action.type === 'cast') maybeQuip('play');
      else if (action.type === 'declare_attackers' && action.attackers && action.attackers.length) maybeQuip('attack');
      tick();
    }, settings.aiDelay);
    return;
  }

  // Arena-style: don't stop the player at combat steps where there's nothing
  // to do (no creature can attack / nothing can block) — just skip them.
  if (settings.autoPass && ui.mode === 'idle') {
    if (aw.type === 'attackers' && !G.players[HUMAN].battlefield.some((c) => isCreature(c) && canAttack(G, c))) {
      return void setTimeout(() => {
        const now = G.awaiting;
        if (!now || now.player !== HUMAN || now.type !== 'attackers') return;
        try { applyAction(G, HUMAN, { type: 'declare_attackers', attackers: [] }); } catch { return; }
        tick();
      }, 140);
    }
    if (aw.type === 'blockers' && !G.players[HUMAN].battlefield.some((c) => isCreature(c) && !c.tapped)) {
      return void setTimeout(() => {
        const now = G.awaiting;
        if (!now || now.player !== HUMAN || now.type !== 'blockers') return;
        try { applyAction(G, HUMAN, { type: 'declare_blockers', blocks: {} }); } catch { return; }
        tick();
      }, 140);
    }
  }

  // Human's decision. Skip the ones with nothing in them.
  if (settings.autoPass && aw.type === 'priority' && ui.mode === 'idle') {
    const actions = legalActions(G, HUMAN);
    if (actions.length === 1 && actions[0].type === 'pass') {
      const beat = G.stack.length ? 520 : 110;
      setTimeout(() => {
        const now = G.awaiting;
        if (!now || now.player !== HUMAN || now.type !== 'priority' || ui.mode !== 'idle') return;
        try { applyAction(G, HUMAN, { type: 'pass' }); } catch { return; }
        tick();
      }, beat);
    }
  }
}

function act(action) {
  try {
    applyAction(G, HUMAN, action);
  } catch (err) {
    toast(err.message);
    return;
  }
  ui = { mode: 'idle' };
  tick();
}

function toast(message) {
  const t = el('div', 'toast', message);
  document.body.append(t);
  setTimeout(() => t.remove(), 2700);
}

// ------------------------------------------------------- opponent voice ----

/** Show the opponent's speech bubble and speak the line. */
function saySpeech(text) {
  if (!text) return;
  const node = $('oppSpeech');
  if (!node) return;
  node.innerHTML = '';
  node.append(el('span', 'ob-avatar', opponent.avatar), el('span', 'ob-text', text));
  node.classList.remove('hidden');
  node.classList.remove('show');
  void node.offsetWidth;     // restart the entrance animation
  node.classList.add('show');
  clearTimeout(saySpeech._timer);
  saySpeech._timer = setTimeout(() => node.classList.add('hidden'), 4200);
  speak(opponent, text);
}

/** Fire a trash-talk line for an event, throttled so it isn't spammy. */
function maybeQuip(event, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastQuipAt < 3200) return;
  if (event === 'play' && !force && Math.random() > 0.5) return; // not every play
  const line = quipFor(opponent, event);
  if (!line) return;
  lastQuipAt = now;
  saySpeech(line);
}

// ------------------------------------------------------------ render ----

function render() {
  renderTags();
  renderPhase();
  renderBattlefield();
  renderStack();
  renderHand();
  renderPrompt();
  renderLog();
  runFx();
  drawArrow();
}

// -------------------------------------------------------- targeting arrow ----
let lastMouse = { x: 0, y: 0 };

function arrowSource() {
  // Where the aiming arrow starts — only while you're choosing a target/block.
  if (ui.mode === 'targeting') return { x: window.innerWidth / 2, y: window.innerHeight - 96 };
  if (ui.mode === 'blockers' && ui.pending) {
    const n = cardNodeFor(ui.pending);
    if (n) { const r = n.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }
  }
  return null;
}

function drawArrow() {
  const svg = $('arrowLayer'); const path = $('arrowPath');
  if (!svg || !path) return;
  const from = arrowSource();
  if (!from) { svg.classList.add('hidden'); return; }
  const to = lastMouse;
  const mx = (from.x + to.x) / 2;
  const my = Math.min(from.y, to.y) - 55;
  path.setAttribute('d', `M ${from.x} ${from.y} Q ${mx} ${my} ${to.x} ${to.y}`);
  svg.classList.remove('hidden');
}

// ------------------------------------------------------------- effects ----
// Fire one-shot combat/spell effects by diffing the previous render against the
// current one, so each animation plays exactly when something actually happens
// (a creature takes damage, taps, enters; a spell resolves; life changes) —
// never on an idle re-render.
let fxPrev = null;

function snapshotFx() {
  const creatures = new Map();
  const present = new Set();
  for (const pid of [HUMAN, AI]) {
    for (const c of V.players[pid].battlefield) {
      present.add(c.iid);
      creatures.set(c.iid, { damage: c.damage || 0, tapped: !!c.tapped });
    }
  }
  return {
    life: [V.players[HUMAN].life, V.players[AI].life],
    creatures, present,
    stack: new Set(V.stack.map((s) => s.sid)),
    stackColor: new Map(V.stack.map((s) => [s.sid, (cardDef(s.defId).colour || 'C')])),
    attColors: ((V.combat && V.combat.attackers) || []).map((iid) => {
      const c = findInView(iid);
      return c ? (cardDef(c).colour || 'C') : 'C';
    }),
    hand: [V.players[HUMAN].handCount, V.players[AI].handCount],
    attackers: (V.combat && V.combat.attackers) ? V.combat.attackers.length : 0,
  };
}

function runFx() {
  const cur = snapshotFx();
  const prev = fxPrev;
  fxPrev = cur;
  if (!prev) return; // first paint — nothing to animate against

  // Visual + sound flags (fire each sound at most once per render).
  let sHit = false, sTap = false, sEnter = false, sDeath = false;

  for (const [iid, now] of cur.creatures) {
    const node = cardNodeFor(iid);
    const before = prev.creatures.get(iid);
    if (!prev.present.has(iid)) { if (node) flashNode(node, 'fx-enter'); sEnter = true; continue; }
    if (before && now.damage > before.damage) {
      if (node) { flashNode(node, 'fx-hit'); floatOver(node.parentElement, `-${now.damage - before.damage}`, 'fx-dmg'); }
      sHit = true;
    }
    if (before && now.tapped && !before.tapped) { if (node) flashNode(node, 'fx-tap'); sTap = true; }
  }

  // A creature that was on the battlefield and now isn't → it died / left (graveyard).
  for (const iid of prev.present) if (!cur.present.has(iid)) { sDeath = true; break; }

  for (const pid of [HUMAN, AI]) {
    const delta = cur.life[pid] - prev.life[pid];
    const tag = $(pid === HUMAN ? 'tagYou' : 'tagAi');
    if (delta < 0) {
      floatOver(tag, `${delta}`, 'fx-dmg');
      // Elemental burst on the life orb, themed by whatever dealt the damage.
      let colour = null;
      for (const sid of prev.stack) if (!cur.stack.has(sid)) { colour = prev.stackColor.get(sid); break; }
      if (!colour) { const ac = cur.attColors.length ? cur.attColors : prev.attColors; if (ac && ac.length) colour = ac[0]; }
      lifeBurst(pid, colour || 'R');
      sHit = true;
    } else if (delta > 0) floatOver(tag, `+${delta}`, 'fx-heal');
  }
  if (cur.life[HUMAN] < prev.life[HUMAN]) shakeBoard(prev.life[HUMAN] - cur.life[HUMAN]);

  let sResolve = false;
  for (const sid of prev.stack) if (!cur.stack.has(sid)) { pulseBoard(); sResolve = true; break; }
  let sCast = false;
  for (const sid of cur.stack) if (!prev.stack.has(sid)) { sCast = true; break; }
  const sDraw = cur.hand[HUMAN] > prev.hand[HUMAN];
  const sAttack = cur.attackers > prev.attackers;

  // Sounds — the tactile layer.
  if (sCast) sfx.cast();
  if (sAttack) sfx.attack();
  if (sHit) sfx.damage();
  if (sDeath) sfx.death();
  if (sTap) sfx.tap();
  if (sEnter) sfx.play();
  if (sDraw) sfx.draw();
}

function flashNode(node, cls) {
  if (!node) return;
  node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls);
  setTimeout(() => node.classList && node.classList.remove(cls), 720);
}

function floatOver(host, text, cls) {
  if (!host) return;
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  const f = el('div', `fx-float ${cls}`, text);
  host.append(f);
  setTimeout(() => f.remove(), 950);
}

function shakeBoard(amount) {
  const b = document.querySelector('.board');
  if (!b) return;
  const cls = amount >= 4 ? 'fx-shake-big' : 'fx-shake';
  b.classList.remove('fx-shake', 'fx-shake-big'); void b.offsetWidth; b.classList.add(cls);
  setTimeout(() => b.classList.remove(cls), 520);
}

function pulseBoard() {
  const b = document.querySelector('.board');
  if (!b) return;
  b.classList.remove('fx-pulse'); void b.offsetWidth; b.classList.add('fx-pulse');
  setTimeout(() => b.classList.remove('fx-pulse'), 460);
}

// Element theme per mana colour, for the life-hit burst.
const ELEM = { R: '🔥', U: '💧', B: '💀', G: '🌿', W: '✨', C: '⚡' };

function lifeBurst(pid, colour) {
  const tag = $(pid === HUMAN ? 'tagYou' : 'tagAi');
  const orb = tag && tag.querySelector('.life');
  if (!orb) return;
  const r = orb.getBoundingClientRect();
  const b = el('div', `life-burst burst-${colour}`, ELEM[colour] || '⚡');
  b.style.left = `${r.left + r.width / 2}px`;
  b.style.top = `${r.top + r.height / 2}px`;
  document.body.append(b);
  setTimeout(() => b.remove(), 900);
}

// Available mana as coloured pips (Arena-style crystals), so you can see what
// you can afford at a glance. Counts untapped lands + non-summoning-sick mana
// creatures by the colour they produce.
function manaEl(pid) {
  const pool = { W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 };
  for (const c of V.players[pid].battlefield) {
    if (c.tapped) continue;
    const d = cardDef(c);
    if (!d.produces || !d.produces.length) continue;
    if (isCreature(c) && c.summoningSick && !has(V, c, 'haste')) continue;
    for (const col of d.produces) if (pool[col] !== undefined) pool[col]++;
  }
  const wrap = el('span', 'mana-avail');
  let shown = 0;
  for (const col of ['W', 'U', 'B', 'R', 'G', 'C']) {
    for (let i = 0; i < pool[col] && shown < 14; i++, shown++) wrap.append(el('span', `mpip ${col}`));
  }
  if (shown) wrap.title = `${shown} mana available`;
  return wrap;
}

function renderTags() {
  const you = V.players[HUMAN];
  const ai = V.players[AI];

  const tag = (p, node, showHand, avatar) => {
    node.innerHTML = '';
    node.style.cssText = '';
    node.onclick = null;
    node.className = `player-tag${V.activePlayer === p.id ? ' active' : ''}`;
    node.classList.remove('targetable-player');
    if (avatar) node.append(el('span', 'tag-avatar', avatar));
    node.append(el('span', 'pname', p.name));
    // Pulse the orb when life changes (fresh element => animation plays once).
    const changed = lifePrev[p.id] !== undefined && lifePrev[p.id] !== p.life;
    const down = changed && p.life < lifePrev[p.id];
    const life = el('span', `life${p.life <= 5 ? ' low' : ''}${changed ? ' pulse' : ''}${down ? ' down' : ''}`, String(p.life));
    lifePrev[p.id] = p.life;
    node.append(life);
    node.append(manaEl(p.id));
    const counts = el('span', 'counts');
    counts.append(el('span', null, `${p.handCount} in hand`), el('span', null, `${p.librarySize} in deck`));
    if (p.graveyard.length) counts.append(el('span', null, `${p.graveyard.length} in graveyard`));
    node.append(counts);
    if (showHand) {
      const backs = el('span', 'opp-hand');
      for (let i = 0; i < Math.min(p.handCount, 9); i++) {
        const b = el('span', 'cardback');
        b.style.width = '22px';
        b.style.height = '31px';
        backs.append(b);
      }
      node.append(backs);
    }
  };

  tag(ai, $('tagAi'), true, opponent.avatar);
  tag(you, $('tagYou'), false);
}

function renderPhase() {
  const yours = V.activePlayer === HUMAN;
  $('turnLabel').textContent = yours ? 'Your turn' : `${V.players[AI].name}'s turn`;
  $('stepLabel').textContent = STEP_LABELS[V.step] || V.step;
  const info = document.querySelector('.turn-info');
  if (info) info.classList.toggle('your-turn', yours);

  const track = $('phaseTrack');
  track.innerHTML = '';
  const shown = ['untap', 'draw', 'main1', 'declare_attackers', 'declare_blockers', 'combat_damage', 'main2', 'end'];
  const labels = { untap: 'Untap', draw: 'Draw', main1: 'Main 1', declare_attackers: 'Attack', declare_blockers: 'Block', combat_damage: 'Damage', main2: 'Main 2', end: 'End' };
  const activeIdx = shown.indexOf(V.step);
  shown.forEach((s, i) => {
    const cls = s === V.step ? 'on' : (activeIdx >= 0 && i < activeIdx ? 'done' : '');
    track.append(el('span', cls, labels[s]));
  });
}

function renderBattlefield() {
  const rows = {
    aiCreatures: V.players[AI].battlefield.filter(isCreature),
    aiLands: V.players[AI].battlefield.filter((c) => !isCreature(c)),
    youLands: V.players[HUMAN].battlefield.filter((c) => !isCreature(c)),
    youCreatures: V.players[HUMAN].battlefield.filter(isCreature),
  };
  for (const [id, cards] of Object.entries(rows)) {
    const node = $(id);
    node.innerHTML = '';
    const small = id.endsWith('Lands');
    for (const c of cards) {
      const slot = el('div', `slot${small ? ' small' : ''}${c.tapped ? ' is-tapped' : ''}`);
      slot.append(renderCard(c, { small, onBattlefield: true }));
      node.append(slot);
    }
  }
}

function renderStack() {
  const area = $('stackArea');
  area.innerHTML = '';
  if (!V.stack.length) {
    area.append(el('span', 'stack-empty', 'stack empty'));
    return;
  }
  for (const item of V.stack) {
    const d = cardDef(item.defId);
    const node = el('div', 'stack-item');
    node.append(el('span', null, d.name + (item.kind === 'trigger' ? ' (trigger)' : '')));
    node.append(el('span', 'who', V.players[item.controller].name));
    if (item.targets.length) node.append(el('span', 'who', `→ ${item.targets.map(targetName).join(', ')}`));
    area.append(node);
  }
}

function targetName(t) {
  if (t.t === 'player') return V.players[t.id].name;
  if (t.t === 'spell') { const s = V.stack.find((x) => x.sid === t.sid); return s ? cardDef(s.defId).name : 'a spell'; }
  const c = findInView(t.iid);
  return c ? cardDef(c).name : 'something';
}

function findInView(iid) {
  for (const p of V.players) {
    for (const z of ['battlefield', 'hand', 'graveyard', 'exile']) {
      const c = p[z].find((x) => x.iid === iid);
      if (c) return c;
    }
  }
  return null;
}

function renderHand() {
  const node = $('hand');
  node.innerHTML = '';
  const actions = G.awaiting && G.awaiting.player === HUMAN ? legalActions(G, HUMAN) : [];
  const byIid = new Map();
  for (const a of actions) if (a.iid !== undefined) byIid.set(a.iid, a);

  const mulliganing = G.awaiting && G.awaiting.type === 'mulligan' && G.awaiting.player === HUMAN;
  const need = mulliganing ? Math.min(V.mulliganCounts[HUMAN], V.players[HUMAN].hand.length) : 0;

  for (const c of V.players[HUMAN].hand) {
    const action = ui.mode === 'idle' ? byIid.get(c.iid) : null;
    const chosen = mulliganing && ui.bottom && ui.bottom.has(c.iid);
    const card = renderCard(c, { hand: true, playable: !!action });
    if (chosen) card.classList.add('chosen');
    if (action) card.onclick = () => beginPlay(action);
    if (mulliganing && need > 0) {
      card.classList.add('selectable');
      card.onclick = () => {
        if (ui.bottom.has(c.iid)) ui.bottom.delete(c.iid);
        else if (ui.bottom.size < need) ui.bottom.add(c.iid);
        render();
      };
    }
    node.append(card);
  }
  if (!V.players[HUMAN].hand.length) node.append(el('span', 'stack-empty', 'hand empty'));
}

const SECOND_PERSON = {
  is: 'are', has: 'have', does: 'do', draws: 'draw', gains: 'gain', loses: 'lose',
  plays: 'play', casts: 'cast', attacks: 'attack', blocks: 'block', discards: 'discard',
  mulligans: 'mulligan', keeps: 'keep', concedes: 'concede', goes: 'go',
};

function humanise(text) {
  // Log lines are always subject-first ("You draws a card and loses."), so once
  // a line is about "You" every verb in it needs the swap, not just the first.
  if (!text.startsWith('You ')) return text;
  return text.replace(/\b\w+\b/g, (word) => SECOND_PERSON[word] || word);
}

function renderLog() {
  const body = $('logBody');
  if ($('logPanel').classList.contains('hidden')) return;
  body.innerHTML = '';
  for (const line of V.log) {
    const n = el('div', `line${line.text.startsWith('---') ? ' turnmark' : ''}`);
    n.append(el('span', 'meta', `T${line.turn}`), document.createTextNode(humanise(line.text.replace(/^--- | ---$/g, ''))));
    body.append(n);
  }
  body.scrollTop = body.scrollHeight;
}

// ------------------------------------------------------------- cards ----

const SIGILS = [
  '<path d="M50 12 L84 78 H16 Z" />',
  '<circle cx="50" cy="45" r="26" /><path d="M50 8 V82" stroke-width="3" />',
  '<path d="M20 70 Q50 8 80 70 Q50 52 20 70 Z" />',
  '<rect x="26" y="20" width="48" height="48" rx="6" /><path d="M26 44 H74" stroke-width="3" />',
  '<path d="M50 10 L70 34 L90 45 L70 56 L50 80 L30 56 L10 45 L30 34 Z" />',
  '<path d="M24 74 L50 16 L76 74" stroke-width="4" fill="none" /><circle cx="50" cy="52" r="12" />',
];

function hashId(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function artFor(d) {
  const colour = d.colour || 'C';
  const tint = getComputedStyle(document.documentElement).getPropertyValue(`--c-${colour}`).trim() || '#a9b0bd';
  const h = hashId(d.id);
  const sigil = SIGILS[h % SIGILS.length];
  const angle = 120 + (h % 7) * 20;
  return `
    <svg viewBox="0 0 100 90" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="g${h}" gradientTransform="rotate(${angle % 90})">
          <stop offset="0%" stop-color="${tint}" stop-opacity="0.30"/>
          <stop offset="100%" stop-color="${tint}" stop-opacity="0.05"/>
        </linearGradient>
      </defs>
      <rect width="100" height="90" fill="url(#g${h})"/>
      <g transform="translate(0,4) scale(1,0.86)" fill="${tint}" fill-opacity="0.20" stroke="${tint}" stroke-opacity="0.35">
        ${sigil}
      </g>
    </svg>`;
}

/**
 * Swap a real card's placeholder sigil for its actual Scryfall art once (if
 * ever) it loads. The sigil stays underneath the whole time, so a blocked or
 * slow fetch — including the total block in this sandbox's own environment —
 * just leaves the placeholder in place instead of an empty box.
 */
function attachRealArt(artNode, d) {
  fetchCardImage(d.scryfallName).then((images) => {
    if (!images || !images.normal) return;
    const img = new Image();
    img.className = 'real-art';
    img.alt = d.name;
    img.onload = () => {
      artNode.prepend(img);
      // Show the FULL real card (art + name + text + P/T are baked into the
      // image) rather than a cropped window. CSS hides the reconstructed frame.
      const card = artNode.closest('.card');
      if (card) card.classList.add('full-art');
    };
    img.onerror = () => { /* leave the sigil showing */ };
    img.src = images.normal;
  });
}

function renderCard(c, opts = {}) {
  if (c.hidden) {
    const back = el('div', 'cardback');
    return back;
  }
  const d = cardDef(c);
  const node = el('div', `card ${d.colour || 'C'}`);
  if (opts.hand) node.classList.add('hand');
  if (opts.small) node.classList.add('small');
  if (c.tapped) node.classList.add('tapped');
  if (opts.playable) node.classList.add('playable');
  if (opts.onBattlefield && isCreature(c) && c.summoningSick && !has(V, c, 'haste')) node.classList.add('sick');
  if (c.attacking) node.classList.add('attacking');
  if (c.blocking !== null && c.blocking !== undefined) node.classList.add('blocking');

  const top = el('div', 'top');
  top.append(el('div', 'cname', d.name));
  if (d.cost) {
    const cost = el('div', 'cost');
    for (const sym of costSymbols(d.cost)) {
      cost.append(el('span', `pip ${'WUBRG'.includes(sym) ? sym : ''}`, sym));
    }
    top.append(cost);
  }
  node.append(top);

  const art = el('div', 'art');
  art.innerHTML = artFor(d);
  node.append(art);
  if (d.real && d.scryfallName) attachRealArt(art, d);

  const line = [d.types.join(' '), d.subtypes && d.subtypes.length ? `— ${d.subtypes.join(' ')}` : ''].join(' ').trim();
  node.append(el('div', 'typeline', line));

  if (d.text) node.append(el('div', 'rules', d.text));

  if (isCreature(c)) {
    const p = opts.onBattlefield ? power(V, c) : d.power;
    const t = opts.onBattlefield ? toughness(V, c) : d.toughness;
    const cls = p > d.power || t > d.toughness ? ' buffed' : (p < d.power || t < d.toughness ? ' hurt' : '');
    node.append(el('div', `pt${cls}`, `${p}/${t}`));
    if (opts.onBattlefield && c.damage > 0) node.append(el('div', 'damage', `${c.damage} dmg`));
  }

  if (c.attacking) node.append(el('div', 'badge atk', 'attacking'));
  if (c.blocking !== null && c.blocking !== undefined) {
    const target = findInView(c.blocking);
    node.append(el('div', 'badge blk', `blocks ${target ? cardDef(target).name.split(' ')[0] : ''}`));
  }
  return node;
}

// --------------------------------------------------------- prompt bar ----

function renderPrompt() {
  const promptNode = $('prompt');
  const actionsNode = $('promptActions');
  promptNode.innerHTML = '';
  actionsNode.innerHTML = '';

  const aw = G.awaiting;
  if (G.winner !== null) return say(promptNode, 'Game over.');
  if (!aw) return say(promptNode, '');

  if (aw.player === AI) {
    const what = {
      mulligan: 'considering a mulligan', attackers: 'declaring attackers', blockers: 'declaring blockers',
      priority: 'thinking', choose_targets: 'choosing targets',
    }[aw.type] || 'thinking';
    return say(promptNode, `${opponent.name} is ${what}…`);
  }

  if (aw.type === 'mulligan') return renderMulligan(promptNode, actionsNode);
  if (ui.mode === 'targeting') return renderTargeting(promptNode, actionsNode);
  if (aw.type === 'attackers') return renderAttackPrompt(promptNode, actionsNode);
  if (aw.type === 'blockers') return renderBlockPrompt(promptNode, actionsNode);
  if (aw.type === 'choose_targets') {
    ui = { mode: 'targeting', kind: 'trigger', specs: aw.specs, options: aw.specs.map((s) => legalTargets(G, s, HUMAN)), chosen: [] };
    return renderTargeting(promptNode, actionsNode);
  }

  // Ordinary priority. Lead with the phase in plain language so it's always
  // obvious where you are and what to do.
  const actions = legalActions(G, HUMAN);
  const playable = actions.filter((a) => a.type !== 'pass').length;
  const phase = STEP_LABELS[V.step] || V.step;
  if (G.stack.length) {
    say(promptNode, `ON THE STACK — ${playable ? 'respond with an instant, or let it resolve.' : 'let it resolve.'}`);
  } else if (V.activePlayer === HUMAN) {
    const isMain = V.step === 'main1' || V.step === 'main2';
    const tip = isMain
      ? (playable ? 'play a land or cast a spell, then press Next.' : 'nothing to play — press Next.')
      : (playable ? 'you may act, or press Next.' : 'nothing to do — press Next.');
    say(promptNode, `YOUR TURN · ${phase} — ${tip}`);
  } else {
    say(promptNode, `${opponent.name.toUpperCase()}'S TURN · ${phase} — ${playable ? 'you may respond with an instant, or pass.' : 'waiting — press Pass.'}`);
  }

  const pass = el('button', 'btn primary', G.stack.length ? 'Let it resolve' : (V.activePlayer === HUMAN ? 'Next ▶' : 'Pass ▶'));
  pass.onclick = () => act({ type: 'pass' });
  actionsNode.append(pass);
}

function renderMulligan(promptNode, actionsNode) {
  if (ui.mode !== 'mulligan') ui = { mode: 'mulligan', bottom: new Set() };
  const need = Math.min(V.mulliganCounts[HUMAN], V.players[HUMAN].hand.length);
  const taken = V.mulliganCounts[HUMAN];

  if (need === 0) {
    say(promptNode, taken ? `Opening hand of ${V.players[HUMAN].hand.length}. Keep it or go again?` : 'Your opening hand. Keep it or mulligan?');
  } else {
    say(promptNode, `Keeping means putting ${need} card${need === 1 ? '' : 's'} on the bottom — ${ui.bottom.size} of ${need} chosen.`);
  }

  const keep = el('button', 'btn primary', need ? `Keep ${V.players[HUMAN].hand.length - need}` : 'Keep');
  keep.disabled = ui.bottom.size !== need;
  keep.onclick = () => act({ type: 'keep', bottom: [...ui.bottom] });
  actionsNode.append(keep);

  const actions = legalActions(G, HUMAN);
  if (actions.some((a) => a.type === 'mulligan')) {
    const mull = el('button', 'btn ghost', `Mulligan to ${V.players[HUMAN].hand.length - taken - 1}`);
    mull.onclick = () => { ui = { mode: 'idle' }; act({ type: 'mulligan' }); };
    actionsNode.append(mull);
  }
}

function say(node, text) {
  node.append(el('span', null, text));
}

// ---------------------------------------------------------- targeting ----

function beginPlay(action) {
  if (action.type === 'play_land') return act({ type: 'play_land', iid: action.iid });
  if (!action.specs || !action.specs.length) return act({ type: 'cast', iid: action.iid, targets: [] });
  ui = { mode: 'targeting', kind: 'cast', iid: action.iid, specs: action.specs, options: action.options, chosen: [] };
  render();
}

function renderTargeting(promptNode, actionsNode) {
  const i = ui.chosen.length;
  const spec = ui.specs[i];
  const options = ui.options[i];
  const sourceName = ui.kind === 'cast'
    ? cardDef(V.players[HUMAN].hand.find((c) => c.iid === ui.iid)).name
    : cardDef(G.awaiting.pending.defId).name;

  say(promptNode, `${sourceName}: choose ${spec.label}.`);

  // Light up the legal targets.
  for (const ref of options) {
    if (ref.t === 'card') {
      const node = cardNodeFor(ref.iid);
      if (node) {
        node.classList.add('targetable');
        node.onclick = () => pickTarget(ref);
      }
    } else if (ref.t === 'player') {
      // Players are targetable by clicking their name plate, and by an explicit
      // button — a highlighted plate on its own is too easy to miss.
      const tagNode = ref.id === HUMAN ? $('tagYou') : $('tagAi');
      tagNode.classList.add('targetable-player');
      tagNode.onclick = () => pickTarget(ref);
      const btn = el('button', 'btn', `Target ${V.players[ref.id].name}`);
      btn.onclick = () => pickTarget(ref);
      actionsNode.append(btn);
    }
  }
  // Spells can only be targeted from the stack display.
  const spellRefs = options.filter((o) => o.t === 'spell');
  for (const ref of spellRefs) {
    const idx = V.stack.findIndex((s) => s.sid === ref.sid);
    const node = $('stackArea').children[idx];
    if (node) {
      node.style.cursor = 'crosshair';
      node.style.borderColor = 'var(--bad)';
      node.onclick = () => pickTarget(ref);
    }
  }

  if (ui.kind === 'cast') {
    const cancel = el('button', 'btn ghost', 'Cancel');
    cancel.onclick = () => { ui = { mode: 'idle' }; render(); };
    actionsNode.append(cancel);
  }
}

function cardNodeFor(iid) {
  for (const rowId of ['aiCreatures', 'aiLands', 'youLands', 'youCreatures']) {
    const row = $(rowId);
    const cards = V.players[rowId.startsWith('ai') ? AI : HUMAN].battlefield
      .filter(rowId.endsWith('Lands') ? (c) => !isCreature(c) : isCreature);
    const idx = cards.findIndex((c) => c.iid === iid);
    if (idx >= 0) return row.children[idx].querySelector('.card');
  }
  return null;
}

function pickTarget(ref) {
  ui.chosen.push(ref);
  if (ui.chosen.length < ui.specs.length) return render();
  const targets = ui.chosen;
  if (ui.kind === 'cast') act({ type: 'cast', iid: ui.iid, targets });
  else act({ type: 'choose_targets', targets });
}

// ------------------------------------------------------------ combat ----

function renderAttackPrompt(promptNode, actionsNode) {
  if (ui.mode !== 'attackers') ui = { mode: 'attackers', selected: new Set() };
  const mine = V.players[HUMAN].battlefield.filter((c) => isCreature(c) && canAttack(G, G.players[HUMAN].battlefield.find((x) => x.iid === c.iid)));

  say(promptNode, `Declare attackers — ${ui.selected.size} selected. Click your creatures to swing.`);

  for (const c of mine) {
    const node = cardNodeFor(c.iid);
    if (!node) continue;
    node.classList.add('selectable');
    if (ui.selected.has(c.iid)) node.classList.add('chosen');
    node.onclick = () => {
      if (ui.selected.has(c.iid)) ui.selected.delete(c.iid);
      else ui.selected.add(c.iid);
      render();
    };
  }

  const attack = el('button', 'btn primary', ui.selected.size ? `Attack with ${ui.selected.size}` : 'No attacks');
  attack.onclick = () => act({ type: 'declare_attackers', attackers: [...ui.selected] });
  actionsNode.append(attack);

  if (mine.length) {
    const all = el('button', 'btn ghost', 'Select all');
    all.onclick = () => { ui.selected = new Set(mine.map((c) => c.iid)); render(); };
    actionsNode.append(all);
  }
}

function renderBlockPrompt(promptNode, actionsNode) {
  if (ui.mode !== 'blockers') ui = { mode: 'blockers', blocks: {}, pending: null };

  const attackers = V.combat.attackers.map(findInView).filter(Boolean);
  const myCreatures = V.players[HUMAN].battlefield.filter((c) => isCreature(c) && !c.tapped);

  const incoming = attackers.reduce((n, a) => n + power(V, a), 0);
  const blocked = Object.entries(ui.blocks).reduce((n, [b, a]) => {
    const atk = findInView(Number(a));
    const blk = findInView(Number(b));
    if (!atk || !blk) return n;
    return n + (has(V, atk, 'trample') ? Math.min(power(V, atk), toughness(V, blk)) : power(V, atk));
  }, 0);

  const hint = ui.pending
    ? `Now click the attacker for ${cardDef(findInView(ui.pending)).name}.`
    : 'Click one of your creatures, then click the attacker it should block.';
  say(promptNode, `Declare blockers — taking ${Math.max(0, incoming - blocked)} damage as it stands. ${hint}`);

  for (const c of myCreatures) {
    const node = cardNodeFor(c.iid);
    if (!node) continue;
    node.classList.add('selectable');
    if (ui.pending === c.iid) node.classList.add('chosen');
    if (ui.blocks[c.iid]) {
      node.classList.add('chosen');
      const atk = findInView(ui.blocks[c.iid]);
      node.append(el('div', 'badge blk', `blocks ${atk ? cardDef(atk).name.split(' ')[0] : ''}`));
    }
    node.onclick = () => {
      if (ui.blocks[c.iid]) { delete ui.blocks[c.iid]; ui.pending = null; }
      else ui.pending = ui.pending === c.iid ? null : c.iid;
      render();
    };
  }

  if (ui.pending) {
    const blocker = G.players[HUMAN].battlefield.find((c) => c.iid === ui.pending);
    for (const a of attackers) {
      const realAttacker = G.players[AI].battlefield.find((c) => c.iid === a.iid);
      if (!realAttacker || !blockLegal(G, realAttacker, blocker)) continue;
      const node = cardNodeFor(a.iid);
      if (!node) continue;
      node.classList.add('targetable');
      node.onclick = () => { ui.blocks[ui.pending] = a.iid; ui.pending = null; render(); };
    }
  }

  const confirm = el('button', 'btn primary', Object.keys(ui.blocks).length ? `Confirm ${Object.keys(ui.blocks).length} block(s)` : 'No blocks');
  confirm.onclick = () => act({ type: 'declare_blockers', blocks: { ...ui.blocks } });
  actionsNode.append(confirm);

  if (Object.keys(ui.blocks).length) {
    const clear = el('button', 'btn ghost', 'Clear');
    clear.onclick = () => { ui.blocks = {}; ui.pending = null; render(); };
    actionsNode.append(clear);
  }
}

// --------------------------------------------------------- end screen ----

function showGameOver() {
  const won = G.winner === HUMAN;
  $('overlayTitle').textContent = won ? 'You win' : `${opponent.name} wins`;
  const last = G.log.slice().reverse().find((l) => /loses|concedes/.test(l.text));
  const reason = last ? humanise(last.text) : '';
  $('overlayText').textContent = `${reason} Turn ${G.turn} — you ${G.players[HUMAN].life} life, ${opponent.name} ${G.players[AI].life}.`;
  $('overlay').classList.remove('hidden');
  if (won) sfx.win(); else sfx.lose();
  maybeQuip(won ? 'lose' : 'win', { force: true });
}

// ------------------------------------------------------------- wiring ----

$('startBtn').onclick = startGame;
$('rematchBtn').onclick = startGame;
$('newDecksBtn').onclick = () => {
  stopVoice();
  $('overlay').classList.add('hidden');
  $('table').classList.add('hidden');
  $('setup').classList.remove('hidden');
};
$('muteBtn').onclick = () => {
  setMuted(!isMuted());
  setSfxMuted(isMuted()); // one button silences voice + sound effects
  $('muteBtn').textContent = isMuted() ? '🔇' : '🔊';
};
$('logBtn').onclick = () => { $('logPanel').classList.toggle('hidden'); renderLog(); };
$('logClose').onclick = () => $('logPanel').classList.add('hidden');
$('concedeBtn').onclick = () => {
  if (!G || G.winner !== null) return;
  if (!confirm('Concede this game?')) return;
  try {
    applyAction(G, HUMAN, { type: 'concede' });
  } catch {
    G.winner = AI; // not our decision point, so end it directly
  }
  tick();
};
document.addEventListener('mousemove', (e) => {
  lastMouse = { x: e.clientX, y: e.clientY };
  if (ui.mode === 'targeting' || (ui.mode === 'blockers' && ui.pending)) drawArrow();
});

// Big readable preview of whatever card you're hovering.
function showCardPreview(cardEl) {
  const pv = $('cardPreview');
  if (!pv || !cardEl) return;
  const clone = cardEl.cloneNode(true);
  ['playable', 'selectable', 'chosen', 'targetable', 'fx-enter', 'fx-hit', 'fx-tap'].forEach((c) => clone.classList.remove(c));
  clone.querySelectorAll('.fx-float').forEach((f) => f.remove());
  pv.innerHTML = '';
  pv.append(clone);
  pv.classList.remove('hidden');
}
function hideCardPreview() { const pv = $('cardPreview'); if (pv) pv.classList.add('hidden'); }

document.addEventListener('mouseover', (e) => {
  const card = e.target.closest && e.target.closest('.card');
  if (card && !card.classList.contains('cardback') && !card.closest('#cardPreview')) showCardPreview(card);
});
document.addEventListener('mouseout', (e) => {
  const card = e.target.closest && e.target.closest('.card');
  if (!card || card.closest('#cardPreview')) return;
  const to = e.relatedTarget;
  if (to && to.closest && to.closest('.card') === card) return; // still inside the same card
  hideCardPreview();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ui.mode === 'targeting' && ui.kind === 'cast') { ui = { mode: 'idle' }; render(); }
  if ((e.key === ' ' || e.key === 'Enter') && G && G.awaiting && G.awaiting.player === HUMAN && G.awaiting.type === 'priority' && ui.mode === 'idle') {
    e.preventDefault();
    act({ type: 'pass' });
  }
});

renderSetup();

// Load with ?debug=1 to poke at the game from the console.
if (new URLSearchParams(location.search).get('debug')) {
  Object.defineProperty(window, 'spellforge', {
    get: () => ({ game: G, view: V, ui, tick, render }),
  });
}
