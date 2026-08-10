/**
 * 基于 Web Audio 的轻量声音系统。所有声音均在浏览器内合成，避免为短音效加载大型媒体文件。
 * AudioContext 只会在用户首次交互后创建，以符合浏览器的自动播放策略。
 */

import { Debug } from "../utils/debug.js?build=20260810-shield-state-value-v167";

const STORAGE_KEY = "five-realms-audio-enabled";
const MUSIC_VOLUME_KEY = "five-realms-music-volume";
const DEFAULT_MUSIC_VOLUME = 0.75;
/** 真实雷击采样（用户选定素材），URL 带当前统一 build 防止浏览器缓存旧声音。 */
const LIGHTNING_SOURCE = "../../assets/audio/lightning.wav?build=20260810-shield-state-value-v167";

// 0–75% 保持原来的线性手感，最后四分之一提供额外余量，让需要更响 BGM 的玩家可以继续推高。
const musicGainForVolume = (volume) => {
  const upperBoost = Math.max(0, (volume - 0.75) / 0.25);
  return volume * 2.2 + upperBoost * upperBoost;
};

const longMelody = (...phrases) => Object.freeze(phrases.flat());

// 每个乐句16步、全曲12句，共192步；晨约74秒、昏约80秒才完成一次循环。
const DAWN_MELODY = longMelody(
  [60,null,64,null,67,null,69,67,64,null,62,null,64,null,67,null],
  [67,null,69,72,69,null,67,null,64,67,64,null,62,null,60,null],
  [60,null,64,null,67,69,72,null,69,67,64,null,62,64,67,null],
  [64,null,67,null,72,71,69,null,67,null,64,62,64,null,67,null],
  [69,72,74,null,72,69,67,null,64,67,69,null,67,64,62,null],
  [67,null,71,72,76,null,74,72,69,null,67,64,67,null,69,null],
  [72,null,76,79,76,null,74,null,72,69,67,null,69,null,72,null],
  [64,67,69,null,72,null,71,69,67,null,64,67,69,null,64,null],
  [60,64,67,72,71,null,69,67,64,null,67,69,72,null,74,null],
  [69,null,72,74,76,null,74,72,69,67,64,null,67,69,72,null],
  [72,null,69,67,64,null,62,64,67,69,67,null,64,62,60,null],
  // 末句停在属音 G4：把收尾从“终止式”改成“导回开头”，循环回第一乐句的 C4 时形成 V→I 自然衔接。
  [67,64,62,null,60,null,64,67,69,null,67,64,62,null,67,null]
);

const DUSK_MELODY = longMelody(
  [57,null,60,null,64,null,65,64,60,null,57,null,55,null,53,null],
  [53,null,57,60,57,null,55,null,52,55,57,null,60,null,57,null],
  [45,null,52,53,57,null,60,57,55,null,52,53,55,null,57,null],
  [60,64,65,null,64,60,57,null,55,57,60,null,57,55,52,null],
  [52,null,55,57,60,null,64,60,57,null,55,52,53,null,55,null],
  [57,null,60,64,65,null,67,65,64,null,60,57,60,null,64,null],
  [64,null,67,69,67,null,65,64,60,null,57,55,57,null,60,null],
  [53,57,60,null,64,null,62,60,57,null,53,55,57,null,52,null],
  [45,52,57,60,59,null,57,53,52,null,55,57,60,null,62,null],
  [60,null,64,65,67,null,65,64,60,57,55,null,57,60,64,null],
  [64,null,60,57,53,null,52,53,55,57,55,null,53,52,48,null],
  // 末句停在 A3：避免旋律跌到最低音 A2 再重新跳回，循环回第一乐句的 A3 时保持同一音区连续。
  [57,53,52,null,48,null,52,55,57,null,55,52,50,null,57,null]
);

export const MUSIC_PROFILES = Object.freeze({
  dawn: Object.freeze({
    tempo: 78,
    lead: DAWN_MELODY,
    // 尾段 G→C 改为 G→G：结束在属和弦上，跨循环点再解决到开头的 C。
    bass: Object.freeze([48,45,43,48,45,50,48,43,45,48,50,47,48,45,43,50,45,48,43,47,48,45,43,43]),
    thirds: Object.freeze([4,3,4,2,4,4,3,4,3,4,4,3,4,3,4,4,3,4,2,3,4,3,4,4]),
    wave: "triangle",
    leadLevel: 0.036,
    padLevel: 0.022
  }),
  dusk: Object.freeze({
    tempo: 72,
    lead: DUSK_MELODY,
    // 尾段 Dm→Am 改为 Dm→Dm：结束在下属和弦上，跨循环点再解决到开头的 Am。
    bass: Object.freeze([45,41,43,40,41,45,43,40,45,41,38,43,45,40,41,43,38,45,41,40,43,41,38,38]),
    thirds: Object.freeze([3,3,4,3,3,3,4,3,3,3,3,4,3,3,3,4,3,3,4,3,4,3,3,3]),
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
    const stored = globalThis.localStorage?.getItem(MUSIC_VOLUME_KEY);
    if (typeof stored !== "string" || stored.trim() === "") return DEFAULT_MUSIC_VOLUME;
    const volume = Number(stored);
    return Number.isFinite(volume) && volume >= 0 && volume <= 1 ? volume : DEFAULT_MUSIC_VOLUME;
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
    this.musicStepsByTeam = { dawn:0, dusk:0 };
    this.musicSources = new Set();
    this.lightningBuffer = null;
    this.lightningBufferPromise = null;
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
    // 首次解锁后后台预加载真实雷击采样，避免第一声闪电因 fetch+decode 明显延迟。
    if (!this.lightningBuffer && !this.lightningBufferPromise) void this.loadLightningBuffer();
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
    if (changed) {
      if (this.musicTeam) this.musicStepsByTeam[this.musicTeam] = this.musicStep;
      this.stopMusicSources();
      this.musicTeam = team;
      this.stopScheduler();
      this.musicStep = this.musicStepsByTeam[team] ?? 0;
      this.nextMusicTime = 0;
    }
    if (this.enabled) void this.unlock();
    return team;
  }

  stopMusic() {
    if (this.musicTeam) this.musicStepsByTeam[this.musicTeam] = this.musicStep;
    this.stopMusicSources();
    this.musicTeam = null;
    this.stopScheduler();
  }

  /** 停止已提前排程但仍存活的音乐节点，避免阵营切换时新旧 BGM 叠音。 */
  stopMusicSources() {
    if (!this.musicSources.size) return;
    const now = this.context?.currentTime ?? 0;
    for (const gain of this.musicSources) {
      try {
        gain.gain.cancelScheduledValues(now);
        // 用短交叉淡化而非瞬时截断：新主题紧接着启动，避免切歌产生可听的停顿/重启感。
        gain.gain.setTargetAtTime(0.0001, now, 0.05);
      } catch { /* 节点已自然结束，忽略。 */ }
    }
    this.musicSources.clear();
  }

  startScheduler() {
    if (this.musicTimer || !this.context || this.context.state !== "running" || !this.musicTeam) return;
    this.nextMusicTime = Math.max(this.context.currentTime + 0.02, this.nextMusicTime);
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
    if (note != null && (step % 2 === 0 || step % 8 === 7)) {
      this.tone(note, time, duration * 1.55, profile.wave, profile.leadLevel, this.musicGain, undefined, true);
    }
    if (step % 8 === 0) {
      const measure = Math.floor(step / 8);
      const bass = profile.bass[measure % profile.bass.length];
      const third = profile.thirds[measure % profile.thirds.length];
      this.tone(bass, time, duration * 7.2, "sine", profile.padLevel, this.musicGain, 0.18, true);
      this.tone(bass + 12 + third, time, duration * 7.2, "triangle", profile.padLevel * 0.32, this.musicGain, 0.24, true);
      this.tone(bass + 19, time, duration * 7.2, "sine", profile.padLevel * 0.2, this.musicGain, 0.28, true);
    }
    if (this.musicTeam === "dawn" && note != null && step % 16 === 12) {
      this.tone(note + 12, time, duration * 2.4, "sine", 0.018, this.musicGain, 0.08, true);
    }
    if (this.musicTeam === "dusk" && note != null && step % 32 === 28) {
      this.tone(note + 7, time, duration * 3.2, "triangle", 0.012, this.musicGain, 0.12, true);
    }
  }

  async play(name, options = {}) {
    if (!this.enabled && !options.force) return false;
    if (!await this.unlock()) return false;
    if (name === "lightning") return this.playLightningSample();
    const throttle = { select:35, draw:75, playCard:55, hit:45, discard:65 }[name] ?? 0;
    const nowMs = globalThis.performance?.now?.() ?? Date.now();
    if (!options.force && nowMs - (this.lastPlayedAt.get(name) ?? -Infinity) < throttle) return false;
    this.lastPlayedAt.set(name, nowMs);
    const method = this[`sound_${name}`];
    if (typeof method !== "function") return false;
    method.call(this, this.context.currentTime + 0.008);
    return true;
  }

  /** 加载并缓存真实雷击采样；失败安全降级为静音，不阻塞任何游戏流程。 */
  async loadLightningBuffer() {
    if (this.lightningBuffer) return this.lightningBuffer;
    if (this.lightningBufferPromise) return this.lightningBufferPromise;
    this.lightningBufferPromise = (async () => {
      const response = await fetch(new URL(LIGHTNING_SOURCE, import.meta.url));
      if (!response.ok) throw new Error(`lightning 素材请求失败：${response.status}`);
      const data = await response.arrayBuffer();
      const buffer = await this.context.decodeAudioData(data);
      this.lightningBuffer = buffer;
      return buffer;
    })().catch((error) => {
      Debug.log("audio", "lightning 素材加载/解码失败，本次雷击静音", error);
      this.lightningBufferPromise = null;
      return null;
    });
    return this.lightningBufferPromise;
  }

  /** 播放真实雷击采样：每次命中创建独立 BufferSource，经 local gain 接入 sfxGain。 */
  async playLightningSample() {
    if (!this.enabled || !this.context || this.context.state !== "running") return false;
    const buffer = await this.loadLightningBuffer();
    if (!buffer) return false;
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    source.buffer = buffer;
    gain.gain.value = 0.9; // lightning 独立 local gain，响度留给浏览器试听后调整
    source.connect(gain).connect(this.sfxGain);
    source.start(this.context.currentTime + 0.005);
    return true;
  }

  tone(note, time, duration, type = "sine", level = 0.1, destination = this.sfxGain, attack = 0.008, tracked = false) {
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
    if (tracked) {
      this.musicSources.add(gain);
      oscillator.onended = () => this.musicSources.delete(gain);
    }
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
