/* =====================================================================
 * OSTINATO Karplus-Strong loop stability proof (R2-1 howling bug)
 *
 * Simulates the exact pluck-voice feedback loop from ostinato.html:
 *   burst -> [delay] -> lowpass biquad -> fb gain -> back into delay
 * with WebAudio semantics (lowpass Q is in dB: Q_linear = 10^(Q/20),
 * RBJ cookbook coefficients, linear-interpolated fractional delay).
 *
 * Proves two things:
 *   1. BUG   — with the shipped parameters (Q default = 1 dB, fb up to
 *      0.86, never released) the loop gain at harmonics near the filter
 *      resonance exceeds 1.0 -> self-oscillation = the shrill howl.
 *   2. FIX   — with lp.Q = -6 dB (no resonance peak), fb <= 0.82 and a
 *      scheduled feedback release, every band x age combination decays
 *      below -60 dBFS well within the audible window, including under
 *      continuous re-excitation.
 *
 * Run: node test/ks-stability.js   (exit 0 = proof holds)
 * =================================================================== */
'use strict';

const SR = 48000;
const ROOT_HZ = 110;

/* pentatonic mapping copied from the game (A minor penta, 2 octaves) */
const PENTA = [0, 3, 5, 7, 10];
function pentaFreq(band, root) {
  const oct = Math.floor(band / 5), deg = PENTA[band % 5];
  return root * Math.pow(2, oct) * Math.pow(2, deg / 12);
}

/* RBJ cookbook lowpass; WebAudio lowpass interprets Q in dB */
function lowpassCoeffs(fc, qDb) {
  const qLin = Math.pow(10, qDb / 20);
  const w0 = 2 * Math.PI * Math.min(fc, SR / 2 * 0.99) / SR;
  const alpha = Math.sin(w0) / (2 * Math.max(1e-4, qLin));
  const cosw = Math.cos(w0);
  const b0 = (1 - cosw) / 2, b1 = 1 - cosw, b2 = (1 - cosw) / 2;
  const a0 = 1 + alpha, a1 = -2 * cosw, a2 = 1 - alpha;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/* peak |H| of the biquad over 20..8000 Hz (theoretical loop-gain factor) */
function biquadPeak(c) {
  let peak = 0;
  for (let f = 20; f <= 8000; f *= 1.01) {
    const w = 2 * Math.PI * f / SR;
    const re1 = Math.cos(-w), im1 = Math.sin(-w);
    const re2 = Math.cos(-2 * w), im2 = Math.sin(-2 * w);
    const numRe = c.b0 + c.b1 * re1 + c.b2 * re2;
    const numIm = c.b1 * im1 + c.b2 * im2;
    const denRe = 1 + c.a1 * re1 + c.a2 * re2;
    const denIm = c.a1 * im1 + c.a2 * im2;
    const mag = Math.sqrt((numRe * numRe + numIm * numIm) / (denRe * denRe + denIm * denIm));
    if (mag > peak) peak = mag;
  }
  return peak;
}

/* time-domain simulation of one voice */
function simulate(opts) {
  const { band, age, qDb, fbRelease, seconds, repluckEvery } = opts;
  const f = pentaFreq(band, ROOT_HZ);
  const dt = Math.min(0.099, 1 / f);
  const D = dt * SR;                       /* fractional delay in samples */
  const decay = Math.pow(0.65, Math.max(0, age - 1));
  const fc = Math.min(8000, 1400 + 500 * band * decay);
  const fb0 = opts.fb != null ? opts.fb : 0.86 - 0.04 * age;
  const c = lowpassCoeffs(fc, qDb);

  const N = Math.floor(seconds * SR);
  const dlLen = Math.ceil(D) + 8;
  const dl = new Float32Array(dlLen);
  let w = 0, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  let seed = 1234567 + band * 31 + age * 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x3fffffff) - 1;

  const winLen = Math.floor(0.25 * SR);
  const peaks = [];
  let winPeak = 0;
  let fbGain = fb0;

  for (let n = 0; n < N; n++) {
    const t = n / SR;
    /* re-excitation: a fresh 30ms burst every `repluckEvery` seconds
       (worst realistic case: the pool voice is re-fired while ringing) */
    const lastPluckT = repluckEvery ? Math.floor(t / repluckEvery) * repluckEvery : 0;
    let burst = 0;
    if (t - lastPluckT < 0.03) burst = rand();
    /* feedback release, re-armed by EVERY pluck exactly like the game:
       setValueAtTime(fb0, at) + setTargetAtTime(0, at+0.9, 0.18). With
       re-plucks every 150ms (< 0.9s) the release never engages and fb
       stays pinned at fb0 for the whole run — the true worst case.    */
    const since = t - lastPluckT;
    fbGain = (fbRelease && since > 0.9) ? fb0 * Math.exp(-(since - 0.9) / 0.18) : fb0;

    /* read fractional delay (linear interp) */
    const rp = w - D;
    const i0 = Math.floor(rp), fr = rp - i0;
    const s0 = dl[((i0 % dlLen) + dlLen) % dlLen];
    const s1 = dl[(((i0 + 1) % dlLen) + dlLen) % dlLen];
    const dOut = s0 + (s1 - s0) * fr;

    /* biquad lowpass on the delay output */
    const y = c.b0 * dOut + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = dOut; y2 = y1; y1 = y;

    /* write delay input = burst + feedback */
    dl[w % dlLen] = burst + y * fbGain;
    w++;

    const a = Math.abs(dOut);
    if (a > winPeak) winPeak = a;
    if ((n + 1) % winLen === 0) { peaks.push(winPeak); winPeak = 0; }
  }
  return { peaks, fc, f, fb: fb0 };
}

const db = v => v <= 1e-12 ? -240 : 20 * Math.log10(v);
let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('  ok:', msg);
  else { failures++; console.error('  FAIL:', msg); }
}

console.log('== KS loop stability proof ==');

/* ---- part 1: theoretical loop gain --------------------------------- */
console.log('[theory: peak filter gain x feedback]');
{
  /* age >= 1 at every pluck() call site (title plucks hardcode age 1,
   * collectFires filters age < 1, requiem clamps to [1,4]), so the
   * shipped worst case was fb = 0.86 - 0.04*1 = 0.82.                 */
  const peakOld = biquadPeak(lowpassCoeffs(3000, 1));   /* shipped default Q */
  const peakNew = biquadPeak(lowpassCoeffs(3000, -6));  /* fixed Q */
  console.log('  lp peak gain  Q=+1dB:', peakOld.toFixed(4), ' Q=-6dB:', peakNew.toFixed(4));
  console.log('  worst loop gain old (fb .82):', (0.82 * peakOld).toFixed(4),
              ' new (fb .82):', (0.82 * peakNew).toFixed(4));
  assert(peakOld * 0.82 > 1.0, 'BUG confirmed in theory: shipped worst loop gain ' +
    (0.82 * peakOld).toFixed(3) + ' > 1 (self-oscillation)');
  assert(peakNew < 1.0, 'fix removes the resonance peak entirely (' + peakNew.toFixed(4) + ' < 1)');
  assert(peakNew * 0.82 < 0.9, 'fixed worst-case loop gain has >=10% margin (' +
    (0.82 * peakNew).toFixed(3) + ')');
}

/* ---- part 2: time-domain — shipped params diverge ------------------- */
console.log('[time domain: shipped parameters (Q=1dB, fb latched)]');
{
  let worstGrowth = -Infinity, worstCase = null;
  for (let band = 0; band <= 9; band++) {
    for (let age = 1; age <= 4; age++) {   /* reachable range: age >= 1 everywhere */
      const r = simulate({ band, age, qDb: 1, fbRelease: false, seconds: 4 });
      const early = r.peaks[1], late = r.peaks[r.peaks.length - 1];
      const growth = db(late) - db(early);
      if (growth > worstGrowth) { worstGrowth = growth; worstCase = { band, age, early, late, fc: r.fc }; }
    }
  }
  console.log('  worst growth:', worstGrowth.toFixed(1) + ' dB over ~3.5s',
    '(band ' + worstCase.band + ', age ' + worstCase.age + ', lp ' + Math.round(worstCase.fc) + 'Hz,',
    db(worstCase.early).toFixed(1) + ' -> ' + db(worstCase.late).toFixed(1) + ' dBFS)');
  assert(worstGrowth > 6, 'BUG reproduced: at least one voice GROWS >6dB unattended (howl)');
}

/* ---- part 3: time-domain — fixed params all decay ------------------- */
console.log('[time domain: fixed parameters (Q=-6dB, fb<=0.82, release @0.9s)]');
{
  let worstLateDb = -Infinity, worst = null;
  for (let band = 0; band <= 9; band++) {
    for (let age = 1; age <= 4; age++) {
      const fb = Math.min(0.82, 0.86 - 0.04 * age);
      const r = simulate({ band, age, fb, qDb: -6, fbRelease: true, seconds: 3 });
      const lateDb = db(r.peaks[r.peaks.length - 1]);   /* 2.75-3.0s window */
      if (lateDb > worstLateDb) { worstLateDb = lateDb; worst = { band, age }; }
    }
  }
  console.log('  worst tail level at 3s:', worstLateDb.toFixed(1), 'dBFS',
    '(band ' + worst.band + ', age ' + worst.age + ')');
  assert(worstLateDb < -60, 'every band x age combination decays below -60dBFS by 3s');
}

/* ---- part 4: continuous re-excitation stays bounded ----------------- */
console.log('[time domain: fixed params, re-excitation every 150ms pins fb at 0.82, 8s]');
{
  let worstPeak = 0;
  for (const band of [0, 4, 9]) {
    const r = simulate({ band, age: 1, fb: 0.82, qDb: -6, fbRelease: true,
                         seconds: 8, repluckEvery: 0.15 });
    const p = Math.max(...r.peaks);
    if (p > worstPeak) worstPeak = p;
  }
  console.log('  worst instantaneous peak:', db(worstPeak).toFixed(1), 'dBFS');
  assert(db(worstPeak) < 12, 're-excited loop with fb pinned stays bounded (no runaway accumulation)');
}

console.log('');
if (failures) { console.error('KS-STABILITY: FAIL (' + failures + ')'); process.exit(1); }
console.log('KS-STABILITY: PROOF HOLDS');
