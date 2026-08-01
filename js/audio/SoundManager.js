/**
 * 基于 Web Audio 的轻量声音系统。所有声音均在浏览器内合成，避免为短音效加载大型媒体文件。
 * AudioContext 只会在用户首次交互后创建，以符合浏览器的自动播放策略。
 */

const STORAGE_KEY = "five-realms-audio-enabled";
const MUSIC_VOLUME_KEY = "five-realms-music-volume";
const DEFAULT_MUSIC_VOLUME = 0.75;

// 0–75% 保持原来的线性手感，最后四分之一提供额外余量，让需要更响 BGM 的玩家可以继续推高。
const musicGainForVolume = (volume) => {
  const upperBoost = Math.max(0, (volume - 0.75) / 0.25);
  return volume * 2.2 + upperBoost * upperBoost;
};

export const MUSIC_PROFILES = Object.freeze({
  dawn: Object.freeze({
    tempo: 78,
    lead: Object.freeze([60, 64, 67, 69, 67, 64, 62, 67, 72, 69, 67, 64, 62, 64, 67, 69]),
    bass: Object.freeze([48, 48, 45, 43]),
    wave: "triangle",
    leadLevel: 0.036,
    padLevel: 0.022
  }),
  dusk: Object.freeze({
    tempo: 72,
    lead: Object.freeze([57, 60, 64, 65, 64, 60, 57, 53, 55, 57, 60, 64, 60, 57, 55, 52]),
    bass: Object.freeze([45, 41, 43, 40]),
    wave: "sine",
    leadLevel: 0.042,
    padLevel: 0.028
  })
});

const midiToFrequency = (note) => 440 * (2 ** ((note - 69) / 12));

function safelyReadPreference() {
  try { return globalThis.localStorage?.getItem(STORAGE_KEY) !== "off"; }
  catch { return true; }
}

function safelyStorePreference(enabled) {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, enabled ? "on" : "off"); }
  catch { /* 隐私模式或禁用存储时仍允许本次会话使用声音。 */ }
}

function safelyReadMusicVolume() {
  try {
    const stored = Number(globalThis.localStorage?.getItem(MUSIC_VOLUME_KEY));
    return Number.isFinite(stored) && stored >= 0 && stored <= 1 ? stored : DEFAULT_MUSIC_VOLUME;
  } catch { return DEFAULT_MUSIC_VOLUME; }
}

function safelyStoreMusicVolume(volume) {
  try { globalThis.localStorage?.setItem(MUSIC_VOLUME_KEY, String(volume)); }
  catch { /* 存储不可用时只保留本次会话设置。 */ }
}

export class SoundManager {
  constructor() {
    this.enabled = safelyReadPreference();
    this.musicVolume = safelyReadMusicVolume();
    this.context = null;
    this.masterGain = null;
    this.sfxGain = null;
    this.musicGain = null;
    this.noiseBuffer = null;
    this.softNoiseBuffer = null;
    this.musicTeam = null;
    this.musicTimer = null;
    this.nextMusicTime = 0;
    this.musicStep = 0;
    this.lastPlayedAt = new Map();
  }

  get isSupported() {
    return Boolean(globalThis.AudioContext || globalThis.webkitAudioContext);
  }

  async unlock() {
    if (!this.enabled || !this.isSupported) return false;
    if (!this.context) this.createGraph();
    if (this.context.state === "suspended") await this.context.resume();
    if (this.musicTeam) this.startScheduler();
    return this.context.state === "running";
  }

  createGraph() {
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    this.context = new AudioContextClass();
    this.masterGain = this.context.createGain();
    this.sfxGain = this.context.createGain();
    this.musicGain = this.context.createGain();
    this.masterGain.gain.value = this.enabled ? 0.82 : 0;
    this.sfxGain.gain.value = 0.9;
    this.musicGain.gain.value = musicGainForVolume(this.musicVolume);
    this.sfxGain.connect(this.masterGain);
    this.musicGain.connect(this.masterGain);
    this.masterGain.connect(this.context.destination);
  }

  async setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    safelyStorePreference(this.enabled);
    if (this.enabled) {
      await this.unlock();
      if (this.masterGain) this.masterGain.gain.setTargetAtTime(0.82, this.context.currentTime, 0.035);
      this.play("select", { force:true });
    } else {
      this.stopScheduler();
      if (this.masterGain) this.masterGain.gain.setTargetAtTime(0.0001, this.context.currentTime, 0.025);
    }
    return this.enabled;
  }

  setMusicVolume(volume) {
    const normalized = Math.min(1, Math.max(0, Number(volume) || 0));
    this.musicVolume = normalized;
    safelyStoreMusicVolume(normalized);
    if (this.musicGain && this.context) {
      this.musicGain.gain.setTargetAtTime(musicGainForVolume(normalized), this.context.currentTime, 0.025);
    }
    return normalized;
  }

  setMusicTeam(team) {
    if (!MUSIC_PROFILES[team]) return this.stopMusic();
    const changed = this.musicTeam !== team;
    this.musicTeam = team;
    if (changed) {
      this.stopScheduler();
      this.musicStep = 0;
      this.nextMusicTime = 0;
    }
    if (this.enabled) void this.unlock();
    return team;
  }

  stopMusic() {
    this.musicTeam = null;
    this.stopScheduler();
  }

  startScheduler() {
    if (this.musicTimer || !this.context || this.context.state !== "running" || !this.musicTeam) return;
    this.nextMusicTime = Math.max(this.context.currentTime + 0.08, this.nextMusicTime);
    this.scheduleMusic();
    this.musicTimer = globalThis.setInterval(() => this.scheduleMusic(), 250);
  }

  stopScheduler() {
    if (this.musicTimer) globalThis.clearInterval(this.musicTimer);
    this.musicTimer = null;
  }

  scheduleMusic() {
    const profile = MUSIC_PROFILES[this.musicTeam];
    if (!this.enabled || !profile || !this.context || this.context.state !== "running") return;
    const stepDuration = 30 / profile.tempo;
    while (this.nextMusicTime < this.context.currentTime + 1.1) {
      this.scheduleMusicStep(profile, this.musicStep, this.nextMusicTime, stepDuration);
      this.musicStep += 1;
      this.nextMusicTime += stepDuration;
    }
  }

  scheduleMusicStep(profile, step, time, duration) {
    const note = profile.lead[step % profile.lead.length];
    if (step % 2 === 0 || step % 8 === 7) {
      this.tone(note, time, duration * 1.55, profile.wave, profile.leadLevel, this.musicGain);
    }
    if (step % 8 === 0) {
      const bass = profile.bass[Math.floor(step / 8) % profile.bass.length];
      this.tone(bass, time, duration * 7.2, "sine", profile.padLevel, this.musicGain, 0.18);
      this.tone(bass + (this.musicTeam === "dawn" ? 7 : 5), time, duration * 7.2, "triangle", profile.padLevel * 0.48, this.musicGain, 0.24);
    }
    if (this.musicTeam === "dawn" && step % 16 === 12) {
      this.tone(note + 12, time, duration * 2.4, "sine", 0.018, this.musicGain, 0.08);
    }
  }

  async play(name, options = {}) {
    if (!this.enabled && !options.force) return false;
    if (!await this.unlock()) return false;
    const throttle = { select:35, draw:75, playCard:55, hit:45, discard:65 }[name] ?? 0;
    const nowMs = globalThis.performance?.now?.() ?? Date.now();
    if (!options.force && nowMs - (this.lastPlayedAt.get(name) ?? -Infinity) < throttle) return false;
    this.lastPlayedAt.set(name, nowMs);
    const method = this[`sound_${name}`];
    if (typeof method !== "function") return false;
    method.call(this, this.context.currentTime + 0.008);
    return true;
  }

  tone(note, time, duration, type = "sine", level = 0.1, destination = this.sfxGain, attack = 0.008) {
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(midiToFrequency(note), time);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), time + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    oscillator.connect(gain).connect(destination);
    oscillator.start(time);
    oscillator.stop(time + duration + 0.03);
  }

  sweep(fromHz, toHz, time, duration, type, level) {
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(fromHz, time);
    oscillator.frequency.exponentialRampToValueAtTime(toHz, time + duration);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(level, time + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    oscillator.connect(gain).connect(this.sfxGain);
    oscillator.start(time);
    oscillator.stop(time + duration + 0.03);
  }

  noise(time, duration, level, filterFrequency = 0, filterType = "highpass", attack = 0.006) {
    if (!this.noiseBuffer) {
      const length = Math.ceil(this.context.sampleRate * 0.55);
      this.noiseBuffer = this.context.createBuffer(1, length, this.context.sampleRate);
      const data = this.noiseBuffer.getChannelData(0);
      for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
    }
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    source.buffer = this.noiseBuffer;
    let destination = gain;
    if (filterFrequency) {
      const filter = this.context.createBiquadFilter();
      filter.type = filterType;
      filter.frequency.value = filterFrequency;
      source.connect(filter).connect(gain);
    } else source.connect(gain);
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(level, time + Math.min(attack, duration * 0.25));
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    destination.connect(this.sfxGain);
    source.start(time);
    source.stop(time + duration);
  }

  /** 低频、非周期的棕噪声脉冲，适合纸牌轻触与木质落桌，不含尖锐白噪声或持续音高。 */
  softNoise(time, duration, level, cutoff = 520, attack = 0.004) {
    if (!this.softNoiseBuffer) {
      const length = Math.ceil(this.context.sampleRate * 0.24);
      this.softNoiseBuffer = this.context.createBuffer(1, length, this.context.sampleRate);
      const data = this.softNoiseBuffer.getChannelData(0);
      let previous = 0;
      for (let index = 0; index < data.length; index += 1) {
        previous = previous * 0.965 + (Math.random() * 2 - 1) * 0.035;
        data[index] = previous * 2.8;
      }
    }
    const source = this.context.createBufferSource();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    source.buffer = this.softNoiseBuffer;
    filter.type = "lowpass";
    filter.frequency.value = cutoff;
    filter.Q.value = 0.45;
    gain.gain.setValueAtTime(0.0001, time);
    gain.gain.exponentialRampToValueAtTime(level, time + Math.min(attack, duration * 0.2));
    gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    source.connect(filter).connect(gain).connect(this.sfxGain);
    source.start(time);
    source.stop(time + duration);
  }

  sound_select(time) {
    this.softNoise(time, 0.032, 0.028, 680, 0.003);
  }

  sound_draw(time) {
    // 两段短促的低通纸张摩擦；不使用持续振荡器，彻底避免飞虫般的嗡鸣和尖锐滑音。
    this.noise(time, 0.075, 0.038, 820, "lowpass", 0.014);
    this.noise(time + 0.052, 0.09, 0.026, 620, "lowpass", 0.018);
  }

  sound_playCard(time) {
    // 全新的低频棕噪声落牌：先轻擦、后轻落，不复用容易产生尖锐感的白噪声声源。
    this.softNoise(time, 0.045, 0.065, 440, 0.006);
    this.softNoise(time + 0.038, 0.065, 0.075, 240, 0.004);
  }

  sound_hit(time) {
    this.noise(time, 0.13, 0.2, 180);
    this.sweep(118, 48, time, 0.23, "sine", 0.2);
  }

  sound_skill(time) {
    [64, 68, 71, 76].forEach((note, index) => this.tone(note, time + index * 0.055, 0.38, index % 2 ? "sine" : "triangle", 0.095));
  }

  sound_discard(time) {
    this.noise(time, 0.2, 0.075, 700);
    this.sweep(520, 155, time, 0.22, "triangle", 0.07);
  }

  sound_heal(time) {
    [60, 64, 67, 72].forEach((note, index) => this.tone(note, time + index * 0.07, 0.42, "sine", 0.085));
  }

  sound_shield(time) {
    this.tone(55, time, 0.52, "triangle", 0.11);
    this.tone(62, time + 0.018, 0.58, "sine", 0.075);
    this.tone(74, time + 0.05, 0.44, "sine", 0.045);
  }
}
