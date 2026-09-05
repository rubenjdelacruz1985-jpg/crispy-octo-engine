// Opponent roster. Each profile is cosmetic + a skill knob + a voice + quips.
//
// - tier/mistakeRate: how well they play. Pros play the engine's best line;
//   weaker profiles sometimes take a random legal action instead (see app.js).
// - voiceId: an ElevenLabs voice (used only when a key is configured; otherwise
//   the browser's speech falls back, tuned by `rate`/`pitch`). These ids are
//   ElevenLabs' public default voices, available on any account.
// - quips: lines fired on game events. {greet, play, attack, damage, win, lose}.

export const PROFILES = [
  {
    id: 'rook', name: 'Rook', avatar: '🧠', tier: 'Pro', mistakeRate: 0,
    blurb: 'Calm, calculating veteran. Punishes every misstep.',
    voiceId: 'pNInz6obpgDQGcFmaJgB', rate: 0.96, pitch: 0.9,
    quips: {
      greet: ['Let us see what you have.', 'I have already seen how this ends.'],
      play:  ['As planned.', 'Every piece has its place.', 'Patience.'],
      attack:['Now we apply pressure.', 'Answer this.'],
      damage:['Predictable.', 'You are behind and you know it.'],
      win:   ['Precisely as calculated.', 'A clean line. Well played to a point.'],
      lose:  ['...Noted. You earned that.', 'An instructive loss.'],
    },
  },
  {
    id: 'vex', name: 'Vex', avatar: '😼', tier: 'Solid', mistakeRate: 0.05,
    blurb: 'Cocky, quick, and never stops talking.',
    voiceId: 'ErXwobaYiN019PkySvjV', rate: 1.08, pitch: 1.1,
    quips: {
      greet: ['Oh, this is gonna be fun. For me.', 'Try to make it interesting.'],
      play:  ['Boom. Handled.', 'Watch and learn.', 'Too easy.'],
      attack:['Swing city, baby!', 'Block it. I dare you.'],
      damage:['Ooh, that had to hurt.', 'Feel that?'],
      win:   ['GG easy. Better luck never.', 'Was there ever any doubt?'],
      lose:  ['Okay okay, lucky draw.', 'Rematch. RIGHT now.'],
    },
  },
  {
    id: 'pip', name: 'Pip', avatar: '🐹', tier: 'Casual', mistakeRate: 0.28,
    blurb: 'Sweet, nervous, still learning. Go easy on them.',
    voiceId: 'MF3mGyEYCl7XYWbV9V6O', rate: 1.06, pitch: 1.25,
    quips: {
      greet: ['Um, hi! I hope this is okay?', 'Be nice? Please?'],
      play:  ['Is... is this good?', 'I think this one does something!', 'Okay, um, this one!'],
      attack:['Eep — attacking! Sorry!', 'Go little guys, go!'],
      damage:['Oh no, did I do that?', 'Sorry!!'],
      win:   ['Wait, I won?! I WON!', 'Oh gosh, did I really?'],
      lose:  ['Aww. That was still fun!', 'Good game! You\'re really good.'],
    },
  },
  {
    id: 'grix', name: 'Grix', avatar: '🔥', tier: 'Reckless', mistakeRate: 0.22,
    blurb: 'All gas, no brakes. Burns first, thinks never.',
    voiceId: 'VR6AewLTigWG4xSOukaG', rate: 1.12, pitch: 0.95,
    quips: {
      greet: ['SMASH TIME.', 'I don\'t plan. I ATTACK.'],
      play:  ['MORE!', 'Throw it all in!', 'Why wait?!'],
      attack:['CHAAARGE!', 'Everybody swings! EVERYBODY!'],
      damage:['HAH! Burn!', 'Face damage is the BEST damage!'],
      win:   ['ASHES! ALL OF IT!', 'Told ya. SMASH.'],
      lose:  ['Bah! Ran outta gas.', 'Fine. That was a good boom.'],
    },
  },
  {
    id: 'sage', name: 'Sage', avatar: '🦉', tier: 'Pro', mistakeRate: 0,
    blurb: 'A patient mentor. Explains why you lost.',
    voiceId: 'EXAVITQu4vr4xnSDxMaL', rate: 0.98, pitch: 1.0,
    quips: {
      greet: ['Let\'s learn something today.', 'Tempo and card advantage. Watch.'],
      play:  ['Value over flash.', 'This trades up, you see.', 'Curve matters.'],
      attack:['I attack because the math favors me.', 'Forcing a bad block.'],
      damage:['Chip damage adds up.', 'Now your clock is real.'],
      win:   ['Study that line — it was inevitable.', 'You\'ll get it next time.'],
      lose:  ['Well played. You read me perfectly.', 'The student surpasses. For now.'],
    },
  },
];

export const DEFAULT_PROFILE = PROFILES[0];

export function profileById(id) {
  return PROFILES.find((p) => p.id === id) || DEFAULT_PROFILE;
}

/** A random quip for an event, or '' if none. */
export function quipFor(profile, event) {
  const list = (profile.quips && profile.quips[event]) || [];
  return list.length ? list[Math.floor(Math.random() * list.length)] : '';
}
