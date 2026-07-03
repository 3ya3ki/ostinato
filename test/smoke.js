/* =====================================================================
 * OSTINATO headless smoke test
 * Stubs: canvas 2d ctx / AudioContext / localStorage. Drives the game:
 * init -> tutorial(first visit) -> title(attract) -> play start ->
 * pseudo mouse motion at 60fps -> asserts: zero exceptions, notes
 * planted, fires happened, collision death, result transition, requiem,
 * 120s endurance, plus regression asserts for Phase 4 round 1/2 fixes
 * (swept collision, visualQueue cap, disablePad, sanitize, KS params,
 * tutorial R2-2).
 *
 * Run: node test/smoke.js
 * =================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const HTML = path.join(__dirname, '..', 'index.html');
const src = fs.readFileSync(HTML, 'utf8');
const m = src.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('no script block'); process.exit(1); }

/* ---- load the game code with module.exports, no window/document ---- */
const module_ = { exports: {} };
const loader = new Function('module', 'window', 'document', m[1]);
loader(module_, undefined, undefined);
const OST = module_.exports;

const failures = [];
function assert(cond, msg) {
  if (cond) { console.log('  ok:', msg); }
  else { failures.push(msg); console.error('  FAIL:', msg); }
}

/* ---- canvas 2d stub ------------------------------------------------- */
function makeCtx(canvas) {
  const grad = { addColorStop() {} };
  const target = {
    canvas,
    measureText: () => ({ width: 10 }),
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    filter: 'none', /* string => hasFilter path is exercised */
  };
  return new Proxy(target, {
    get(t, p) {
      if (p in t) return t[p];
      return (t[p] = () => {}); /* any method: no-op */
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}
function makeCanvas(w, h) {
  const c = { width: w || 300, height: h || 150, style: {} };
  const ctx = makeCtx(c);
  c.getContext = () => ctx;
  return c;
}

/* ---- WebAudio stub (params log their automation for asserts) -------- */
class StubParam {
  constructor(v) { this.value = v || 0; this.log = []; }
  setValueAtTime(v, t) { this.value = v; this.log.push(['set', v, t]); return this; }
  linearRampToValueAtTime(v) { this.value = v; return this; }
  exponentialRampToValueAtTime(v) { this.value = v; return this; }
  setTargetAtTime(v, t, tc) { this.value = v; this.log.push(['target', v, t, tc]); return this; }
  cancelScheduledValues() { return this; }
}
let audioNodesCreated = 0;
class StubNode {
  constructor(ctx) {
    audioNodesCreated++;
    this.context = ctx;
    this.gain = new StubParam(1);
    this.frequency = new StubParam(440);
    this.detune = new StubParam(0);
    this.Q = new StubParam(1);
    this.delayTime = new StubParam(0);
    this.playbackRate = new StubParam(1);
    this.type = 'sine';
    this.buffer = null;
  }
  connect(n) { return n; }
  disconnect() {}
  start() {}
  stop() {}
}
class StubAudioContext {
  constructor() {
    this.currentTime = 0;
    this.state = 'running';
    this.sampleRate = 48000;
    this.destination = new StubNode(this);
  }
  createGain() { return new StubNode(this); }
  createOscillator() { return new StubNode(this); }
  createBiquadFilter() { return new StubNode(this); }
  createDelay() { return new StubNode(this); }
  createConvolver() { return new StubNode(this); }
  createDynamicsCompressor() { return new StubNode(this); }
  createStereoPanner() { return new StubNode(this); }
  createBufferSource() { return new StubNode(this); }
  createBuffer(ch, len, rate) {
    const data = [];
    for (let i = 0; i < ch; i++) data.push(new Float32Array(len));
    return { numberOfChannels: ch, length: len, sampleRate: rate,
      duration: len / rate, getChannelData: i => data[i] };
  }
  resume() { this.state = 'running'; return Promise.resolve(); }
  suspend() { this.state = 'suspended'; return Promise.resolve(); }
}

/* ---- localStorage stub ---------------------------------------------- */
const store = new Map();
const storage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};

console.log('== OSTINATO smoke test ==');

/* pure-logic spot checks first */
console.log('[pure logic]');
const cfg = OST.CONFIG;
assert(OST.pentaFreq(0, 110) === 110, 'band 0 = A2 110Hz');
assert(Math.abs(OST.pentaFreq(5, 110) - 220) < 1e-9, 'band 5 = A3 220Hz (octave)');
assert(OST.scorePerFire(0, cfg) === 0 && OST.scorePerFire(1, cfg) === 0, 'bands 0-1 score 0');
assert(OST.scorePerFire(9, cfg) === 90, 'band 9 scores 90');
assert(OST.bandFromRadius(0.05, cfg) === 0, 'inner dead zone maps to band 0');
assert(OST.bandFromRadius(0.999, cfg) === 9, 'rim maps to band 9');
{
  const tl = new OST.StepTimeline(cfg, 0);
  const evts = [];
  tl.advanceUntil(cfg.REV_PERIOD_START + 0.01, e => evts.push(e));
  assert(evts.length === 17, '16 steps per revolution + first of next (got ' + evts.length + ')');
  assert(evts[16].loop === 1, 'loop increments after 16 steps');
  const h = tl.headAt(cfg.REV_PERIOD_START / 2);
  assert(h.loop === 0 && Math.abs(h.phase - 0.5) < 0.01, 'headAt mid-revolution phase ~0.5');
}
{
  const nf = new OST.NoteField(cfg);
  const bank = new OST.Bank(cfg);
  const n = nf.plant(3, 7, 0, null);
  for (let L = 1; L <= 4; L++) {
    const fires = nf.collectFires(3, L);
    assert(fires.length === 1, 'note fires on loop ' + L);
    bank.onFire(fires[0].per);
    if (fires[0].matured) bank.onMature(fires[0].note);
  }
  assert(n.dead, 'note dies after 4 fires (maturity)');
  assert(bank.banked === 7 * 10 * 4 * 2, 'maturity banks 4*perFire*2 = ' + bank.banked);
  assert(bank.pending === 0, 'pending drained on maturity');
  assert(nf.collectFires(3, 5).length === 0, 'no 5th fire');
}

/* sanitize regression (Phase 4 round 1): hostile URL params are clamped */
console.log('[sanitize]');
{
  const bad = OST.applyConfigOverrides(Object.assign({}, OST.CONFIG),
    '?MAX_RINGS=0&MAX_PARTICLES=-5&PHYS_DT=0&bands=0');
  assert(bad.MAX_RINGS >= 1 && bad.MAX_PARTICLES >= 1, 'MAX_RINGS/MAX_PARTICLES clamped to >=1');
  assert(bad.PHYS_DT >= 1 / 1000, 'PHYS_DT clamped away from 0');
  assert(bad.PITCH_BANDS >= 1, 'PITCH_BANDS clamped to >=1');
}

/* ---- full game drive ------------------------------------------------ */
console.log('[game drive]');
const actx = new StubAudioContext();
const env = {
  canvas: makeCanvas(1280, 720),
  createCanvas: makeCanvas,
  AudioCtx: function () { return actx; },
  storage,
};
const game = OST.createGame(env);
game.resize(1280, 720, 1);

const DT = 1 / 60;
const cx = 640, cy = 360, R = game.view.R;
let t = 0, frames = 0, exceptions = 0, firstError = null;
let sawRecording = false, sawPlaying = false, sawDying = false, sawResult = false;
let maxNotes = 0, maxRings = 0, plantedEver = false;
let deathFrame = -1, resultFrame = -1;

function drive(totalSeconds, mover) {
  const N = Math.round(totalSeconds / DT);
  for (let i = 0; i < N; i++) {
    t += DT;
    actx.currentTime += DT; /* audio clock in lockstep with sim time */
    try {
      const pos = mover(t);
      if (pos) game.pointerMove(pos.x, pos.y, false);
      game.update(DT);
      game.render();
    } catch (e) {
      exceptions++;
      if (!firstError) firstError = e;
    }
    frames++;
    const st = game.state;
    if (st === 'recording') sawRecording = true;
    if (st === 'playing') sawPlaying = true;
    if (st === 'dying' && deathFrame < 0) { sawDying = true; deathFrame = frames; }
    if (st === 'result' && resultFrame < 0) { sawResult = true; resultFrame = frames; }
    const nc = game.field.count();
    if (nc > 0) plantedEver = true;
    if (nc > maxNotes) maxNotes = nc;
    let rc = 0;
    for (const r of game.rings) if (r.alive && !r.harmless) rc++;
    if (rc > maxRings) maxRings = rc;
    if (st === 'result' && frames - resultFrame > 600) break; /* 10s of result is enough */
  }
}

/* phase T: tutorial (R2-2) — storage is empty, so this is a first visit */
console.log('[tutorial R2-2]');
drive(0.1, () => ({ x: 30, y: 30 }));
assert(game.tut.open === true, 'first-ever visit auto-opens the how-to-play panel');
drive(3, () => ({ x: cx + R * 0.5, y: cy })); /* pointer INSIDE the arena */
assert(game.state === 'attract', 'open panel blocks the run from starting');
drive(0.1, () => ({ x: 30, y: 30 }));         /* leave the arena again */
game.keyInput('KeyH', true); game.keyInput('KeyH', false);
assert(game.tut.open === false, 'H closes the panel');
assert(game.tut.seen === true && store.get('ostinato.tutorialSeen') === '1',
  'closing persists tutorialSeen to storage');
game.toggleTutorial();
assert(game.tut.open === true, 'H / toggle reopens the panel on the title');
game.pointerDown(cx, cy, false);
assert(game.tut.open === false, 'a click closes the panel');
assert(game.state === 'attract', 'the closing click does not itself start the run');

/* phase 0: title / attract — pointer far outside the arena (4s) */
drive(4, () => ({ x: 30, y: 30 }));
assert(game.state === 'attract', 'stays in attract while pointer is outside');
assert(game.timeline.loop >= 0 && game.head.loop >= 0, 'revolution-zero head is turning on the title');

/* phase 1: enter the disc, orbit at mid-outer radius (planting) */
drive(0.3, tt => ({ x: cx + R * 0.6, y: cy }));
assert(game.state === 'recording', 'entering the disc starts recording once the panel is closed');
assert(game.tut.hint != null, 'first-run contextual hint appears on recording start');
drive(40, tt => {
  const ang = tt * 0.9;
  const rad = R * (0.55 + 0.28 * Math.sin(tt * 0.5));
  return { x: cx + Math.cos(ang) * rad, y: cy + Math.sin(ang) * rad };
});
game.keyInput('KeyH', true); game.keyInput('KeyH', false);
assert(game.tut.open === false, 'H is inert outside the title screen');

/* phase 2: park on a spot where we planted — our own past fires there */
drive(76, () => ({ x: cx + R * 0.7, y: cy }));

const d = game.debugInfo();
const totalSimSeconds = (frames * DT).toFixed(1);

console.log('[assertions]');
assert(exceptions === 0, 'zero exceptions over ' + frames + ' frames (' + totalSimSeconds + 's sim)');
if (firstError) console.error('  first error:', firstError.stack || firstError);
assert(sawRecording, 'attract -> recording transition happened');
assert(sawPlaying, 'recording -> playing (armed) transition happened');
assert(plantedEver, 'notes were planted (sampling works)');
assert(d.fires > 0, 'note fires happened (' + d.fires + ' fires)');
assert(maxNotes <= 64, 'alive notes never exceeded 64 (max ' + maxNotes + ')');
assert(maxRings <= OST.CONFIG.MAX_RINGS, 'rings capped at ' + OST.CONFIG.MAX_RINGS + ' (max ' + maxRings + ')');
assert(sawDying, 'collision death occurred');
assert(sawResult, 'death -> result transition reached');
assert(game.result && game.result.notes >= 0 && game.result.loops >= 1, 'result stats present');
assert(game.requiem != null, 'requiem (遺曲) player is running in result');
assert(d.banked >= 0 && Number.isFinite(d.banked), 'banked score is a finite number');
assert(store.has('ostinato.best'), 'best score persisted to storage');

/* KS-loop parameter asserts (R2-1 howling fix) */
console.log('[KS voice params R2-1]');
{
  const pool = game.audio._pluckPool;
  assert(pool.length > 0 && pool.every(v => v.lp.Q.value === -6),
    'every pluck voice lowpass Q = -6dB (no resonance peak)');
  let fbSets = 0, fbHigh = 0, fbReleases = 0, lpHigh = 0;
  for (const v of pool) {
    for (const e of v.fb.gain.log) {
      if (e[0] === 'set' && e[1] > 0) { fbSets++; if (e[1] > 0.82 + 1e-9) fbHigh++; }
      if (e[0] === 'target' && e[1] === 0) fbReleases++;
    }
    for (const e of v.lp.frequency.log) {
      if (e[0] === 'set' && e[1] > 8000 + 1e-9) lpHigh++;
    }
  }
  assert(fbSets > 0, 'plucks actually drove the feedback gain (' + fbSets + ' fires)');
  assert(fbHigh === 0, 'feedback gain never set above 0.82');
  assert(fbReleases >= fbSets, 'every fb latch has a scheduled release to 0 (' +
    fbReleases + ' releases / ' + fbSets + ' sets)');
  assert(lpHigh === 0, 'loop lowpass cutoff never set above 8kHz');
}

/* visualQueue cap regression (Phase 4 round 1) */
{
  const before = game.visualQueue.length;
  for (let i = 0; i < 600; i++) game.pushVisual({ type: 'x', t: game.now + 100 + i });
  assert(game.visualQueue.length <= 512, 'visualQueue capped at 512 (' + game.visualQueue.length + ')');
  game.visualQueue.length = 0;
}

const resultA = game.result; /* snapshot before restart clears it */

/* restart via R key, run a few more seconds */
console.log('[restart]');
try {
  game.keyInput('KeyR', true);
  game.keyInput('KeyR', false);
} catch (e) { exceptions++; firstError = firstError || e; }
assert(game.state === 'attract', 'R restarts to a fresh run');
assert(game.tut.open === false, 'restart does not reopen the tutorial (seen persists)');
drive(6, tt => ({ x: cx + Math.cos(tt) * R * 0.6, y: cy + Math.sin(tt) * R * 0.6 }));
assert(exceptions === 0, 'no exceptions after restart');
assert(game.state === 'recording' || game.state === 'playing', 'second run is live again (' + game.state + ')');
assert(game.tut.hint == null, 'contextual hints do not replay on later runs (once per session)');

/* pause path */
game.setPaused(true);
game.update(DT); game.render();
assert(game.paused === true, 'pause engages (blur path)');
game.setPaused(false);

/* =====================================================================
 * Swept-collision regressions (Phase 4 round 1 critical + verify pass)
 * =================================================================== */
console.log('[swept collision regressions]');
function mkPlayingGame() {
  const a = new StubAudioContext();
  const e = { canvas: makeCanvas(1280, 720), createCanvas: makeCanvas,
    AudioCtx: function () { return a; }, storage };
  const g = OST.createGame(e);
  g.resize(1280, 720, 1);
  g.state = 'playing';
  g.inputActive = true; g.player.visible = true; g.pointerIn = true;
  return g;
}
{
  /* a) tunneling: one substep jumps clear across the ring band -> dies */
  const g3 = mkPlayingGame();
  const savedEase = OST.CONFIG.PLAYER_EASE;
  OST.CONFIG.PLAYER_EASE = 0.99; /* huge per-substep jump */
  Object.assign(g3.rings[0], { alive: true, harmless: false, x: cx, y: cy, r: 100, speed: 0, band: 5 });
  g3.player.x = cx + 40; g3.player.y = cy;
  g3.player.tx = cx + 400; g3.player.ty = cy;
  let died3 = false; const die3 = g3.die.bind(g3);
  g3.die = () => { died3 = true; die3(); };
  let ex3 = null;
  try { for (let i = 0; i < 4 && !died3; i++) g3.stepPhysics(OST.CONFIG.PHYS_DT); }
  catch (e) { ex3 = e; }
  OST.CONFIG.PLAYER_EASE = savedEase;
  assert(!ex3, 'tunnel case runs clean' + (ex3 ? ' (' + ex3.message + ')' : ''));
  assert(died3, 'flicking across a ring in one substep still dies (no tunneling)');
}
{
  /* b) outer false-positive (verify pass 6c9b639): player just outside
   * the band fleeing outward faster than the ring grows must SURVIVE */
  const g4 = mkPlayingGame();
  const savedEase = OST.CONFIG.PLAYER_EASE;
  OST.CONFIG.PLAYER_EASE = 0.99;
  Object.assign(g4.rings[0], { alive: true, harmless: false, x: cx, y: cy, r: 200, speed: 240, band: 5 });
  g4.player.x = cx + 207.5; g4.player.y = cy;
  g4.player.tx = cx + 520; g4.player.ty = cy;
  let died4 = false; const die4 = g4.die.bind(g4);
  g4.die = () => { died4 = true; die4(); };
  let ex4 = null;
  try { g4.stepPhysics(OST.CONFIG.PHYS_DT); } catch (e) { ex4 = e; }
  OST.CONFIG.PLAYER_EASE = savedEase;
  assert(!ex4, 'outer-flee case runs clean' + (ex4 ? ' (' + ex4.message + ')' : ''));
  assert(!died4, 'fleeing outward just outside the band does not false-kill');
}

/* =====================================================================
 * RUN B — 120s endurance run.
 * die() is patched out for the survival phase so we can exercise the
 * long game headlessly (maturity banking, layer unlocks, tempo floor,
 * 64-note steady state); the real death path was already proven in
 * run A with a genuine collision. Afterwards die() is restored and the
 * player parks on its own seed to reach the result a second time.
 * =================================================================== */
console.log('[run B: 120s endurance + maturity]');
const actx2 = new StubAudioContext();
const env2 = {
  canvas: makeCanvas(1280, 720),
  createCanvas: makeCanvas,
  AudioCtx: function () { return actx2; },
  storage,
};
const game2 = OST.createGame(env2);
game2.resize(1280, 720, 1);
assert(game2.tut.open === false && game2.tut.fresh === false,
  'returning player (seen flag) gets no auto-tutorial');
const dieReal = game2.die.bind(game2);
let dieBlocked = 0;
game2.die = () => { dieBlocked++; };

let frames2 = 0, ex2 = 0, firstError2 = null;
let maxNotes2 = 0, maxRings2 = 0, minPeriod = 99;
let t2 = 0;
function drive2(totalSeconds, mover) {
  const N = Math.round(totalSeconds / DT);
  for (let i = 0; i < N; i++) {
    t2 += DT;
    actx2.currentTime += DT;
    try {
      const pos = mover(t2);
      if (pos) game2.pointerMove(pos.x, pos.y, false);
      game2.update(DT);
      game2.render();
    } catch (e) { ex2++; if (!firstError2) firstError2 = e; }
    frames2++;
    const nc = game2.field.count();
    if (nc > maxNotes2) maxNotes2 = nc;
    let rc = 0;
    for (const r of game2.rings) if (r.alive) rc++;
    if (rc > maxRings2) maxRings2 = rc;
    if (game2.head && game2.head.period < minPeriod) minPeriod = game2.head.period;
    if (game2.state === 'result' && game2.now - game2.result.t0 > 8) break;
  }
}

/* survive 115s: slow orbit sweeping between mid and outer bands */
drive2(115, tt => {
  const ang = tt * 0.7;
  const rad = R * (0.5 + 0.35 * Math.sin(tt * 0.23));
  return { x: cx + Math.cos(ang) * rad, y: cy + Math.sin(ang) * rad };
});
const d2 = game2.debugInfo();
assert(ex2 === 0, 'run B: zero exceptions over ' + frames2 + ' frames (' + (frames2 * DT).toFixed(1) + 's)');
if (firstError2) console.error('  first error:', firstError2.stack || firstError2);
assert(game2.state === 'playing', 'run B: still playing after 115s (' + game2.state + ')');
assert(d2.matured > 0, 'run B: notes matured (' + d2.matured + ' maturities)');
assert(d2.banked > 0, 'run B: banked score > 0 (' + d2.banked + ')');
assert(d2.pending >= 0, 'run B: pending non-negative (' + d2.pending + ')');
assert(maxNotes2 <= 64, 'run B: 64-note cap held (max ' + maxNotes2 + ')');
assert(maxNotes2 >= 60, 'run B: field saturates near 64 in the long run (max ' + maxNotes2 + ')');
assert(maxRings2 <= OST.CONFIG.MAX_RINGS, 'run B: ring pool cap held (max ' + maxRings2 + ')');
assert(d2.runLoop >= 18, 'run B: reached loop ' + d2.runLoop + ' (>=18)');
/* the 3.2s floor is reached at ~loop 23 (~120s of play, per brief §4);
 * after 115s we must be well down the decay curve                      */
assert(minPeriod <= 3.6, 'run B: tempo decayed on curve (' + minPeriod.toFixed(2) + 's/rev, floor 3.2 at loop 23)');
assert(d2.ghostCueLeft === 0, 'run B: all ' + OST.CONFIG.GHOST_CUE_COUNT + ' causal-ghost cues consumed');
assert(dieBlocked > 0, 'run B: collisions did occur during endurance (blocked ' + dieBlocked + ')');
assert(game2.audio._padOn === true, 'run B: pad layer unlocked by loop 6+');

/* restore death, park on own seed -> genuine death & second result */
game2.die = dieReal;
drive2(20, () => ({ x: cx + R * 0.72, y: cy }));
assert(game2.state === 'result' || game2.state === 'dying',
  'run B: death reached after re-arming die() (' + game2.state + ')');
const res2 = game2.result;
if (res2) {
  assert(res2.loops >= 18, 'run B: result records ' + res2.loops + ' loops');
  assert(res2.notes > 0, 'run B: requiem has ' + res2.notes + ' notes');
}

/* pad must re-lock on restart (Phase 4 round 1 fix) */
game2.restart();
assert(game2.audio._padOn === false, 'restart re-locks the pad layer (disablePad)');

console.log('');
console.log('== SMOKE SUMMARY ==');
console.log('-- run A (default tuning, natural death) --');
console.log('frames simulated   :', frames, '(' + totalSimSeconds + 's at 60fps)');
console.log('exceptions         :', exceptions);
console.log('run loops at death :', resultA ? resultA.loops : d.runLoop);
console.log('requiem notes      :', resultA ? resultA.notes : '-');
console.log('score at death     :', resultA ? resultA.score : '-', '/ lost:', resultA ? resultA.lost : '-');
console.log('total fires        :', d.fires, '/ matured:', d.matured);
console.log('max alive notes    :', maxNotes, '/ max rings:', maxRings);
console.log('-- run B (120s endurance) --');
console.log('frames simulated   :', frames2, '(' + (frames2 * DT).toFixed(1) + 's at 60fps)');
console.log('exceptions         :', ex2);
console.log('loops reached      :', res2 ? res2.loops : d2.runLoop, '/ min period:', minPeriod.toFixed(2) + 's');
console.log('banked / lost      :', game2.bank.banked, '/', game2.bank.lost);
console.log('max notes / rings  :', maxNotes2, '/', maxRings2);
console.log('audio nodes created:', audioNodesCreated, '(all games)');
console.log('');
if (failures.length) {
  console.error('SMOKE: FAIL (' + failures.length + ' failed)');
  process.exit(1);
} else {
  console.log('SMOKE: ALL PASS');
}
