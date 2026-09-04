// Procedural audio - no asset files. An engine drone whose pitch tracks the
// revs, plus short synthesised hits for splats, bone and sheet metal.

import { clamp } from './util.js';

const MAX_HITS_PER_FRAME = 3;

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.started = false;
    this.hitsThisFrame = 0;
    this.lastSplat = 0;
  }

  /** Must be called from a user gesture - browsers block audio otherwise. */
  resume() {
    if (this.ctx === null) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this._build();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  _build() {
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    this.master.connect(ctx.destination);

    // Shared noise buffer for all the percussive hits.
    const len = Math.floor(ctx.sampleRate * 0.5);
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // Engine: two detuned saws through a low-pass that opens with the revs.
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 400;
    this.engineFilter.Q.value = 3;
    this.engineGain.connect(this.engineFilter);
    this.engineFilter.connect(this.master);

    this.osc = [];
    for (const [type, detune, gain] of [['sawtooth', 0, 0.5], ['sawtooth', 7, 0.35], ['square', -1200, 0.2]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = gain;
      o.connect(g);
      g.connect(this.engineGain);
      o.start();
      this.osc.push(o);
    }
    this.started = true;
  }

  _noiseBurst(dur, freq, type, gain, decay = 1) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.6 + Math.random() * 0.8;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur * decay);
    src.connect(f);
    f.connect(g);
    g.connect(this.master);
    src.start(t);
    src.stop(t + dur + 0.05);
  }

  beginFrame() {
    this.hitsThisFrame = 0;
  }

  engine(rpm, gearLow, load) {
    if (!this.started || this.muted) return;
    const base = gearLow ? 62 : 44;
    const f = base + rpm * (gearLow ? 150 : 190);
    const t = this.ctx.currentTime;
    for (const o of this.osc) o.frequency.setTargetAtTime(f, t, 0.05);
    this.engineFilter.frequency.setTargetAtTime(320 + rpm * 1500 + load * 300, t, 0.08);
    this.engineGain.gain.setTargetAtTime(0.035 + rpm * 0.05, t, 0.1);
  }

  idle() {
    if (!this.started) return;
    this.engineGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
  }

  splat(power) {
    if (!this.started || this.muted) return;
    if (this.hitsThisFrame >= MAX_HITS_PER_FRAME) return;
    const now = this.ctx.currentTime;
    if (now - this.lastSplat < 0.035) return;
    this.lastSplat = now;
    this.hitsThisFrame++;
    this._noiseBurst(0.16, 300 + clamp(power, 0, 600) * 0.5, 'lowpass', 0.30);
  }

  bone() {
    if (!this.started || this.muted) return;
    if (this.hitsThisFrame >= MAX_HITS_PER_FRAME) return;
    this.hitsThisFrame++;
    this._noiseBurst(0.09, 2600, 'highpass', 0.16, 0.7);
  }

  crash(force) {
    if (!this.started || this.muted) return;
    this._noiseBurst(0.45, 220, 'lowpass', clamp(force / 500, 0.15, 0.6));
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    const g = ctx.createGain();
    const t = ctx.currentTime;
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.3);
    g.gain.setValueAtTime(0.35, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    o.connect(g);
    g.connect(this.master);
    o.start(t);
    o.stop(t + 0.4);
  }

  shift() {
    if (!this.started || this.muted) return;
    this._noiseBurst(0.07, 1400, 'bandpass', 0.14, 0.6);
  }

  death() {
    if (!this.started || this.muted) return;
    this.crash(600);
    this._noiseBurst(1.2, 160, 'lowpass', 0.4);
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.started) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, this.ctx.currentTime, 0.05);
    }
    return this.muted;
  }
}
