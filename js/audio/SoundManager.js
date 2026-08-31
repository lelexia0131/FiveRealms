/**
 * 基于 Web Audio 的轻量声音系统。所有声音均在浏览器内合成，避免为短音效加载大型媒体文件。
 * AudioContext 只会在用户首次交互后创建，以符合浏览器的自动播放策略。
 */

import { Debug } from "../utils/debug.js";

const STORAGE_KEY = "five-realms-audio-enabled";
const MUSIC_VOLUME_KEY = "five-realms-music-volume";
const SFX_VOLUME_KEY = "five-realms-sfx-volume";
const DEFAULT_MUSIC_VOLUME = 0.75;
const DEFAULT_SFX_VOLUME = 1;
// 保留旧版音效的整体响度基线；SFX 滑条只在这个基线上做线性缩放。
const SFX_GAIN_BASE = 0.9;

// 零 fake-thinking 后连续真实游戏事件会在同一帧内到达；gameplay 音效不得按墙钟
// 节流吞掉，只保留 UI 连点 select 的防误触节流。
export const SOUND_THROTTLE_MS = Object.freeze({ select: 35 });
const LIGHTNING_SOURCE = "../../assets/audio/lightning.wav";

// 0–75% 保持原来的线性手感，最后四分之一提供额外余量，让需要更响 BGM 的玩家可以继续推高。
/*
功能
把用户音乐音量映射为 BGM gain，并在高端提供渐进增益。

调用方
SoundManager.createGraph、setMusicVolume。

输入
归一化音量 [0, 1]。

输出
用于 Web Audio GainNode 的非负增益。

读取状态
无。

写入状态
无。

调用函数
Math.max。

边界与不变量
0 至 0.75 保持既有线性手感，额外增益只作用于最后四分之一。
*/
const musicGainForVolume = (volume) => {
  const upperBoost = Math.max(0, (volume - 0.75) / 0.25);
  return volume * 2.2 + upperBoost * upperBoost;
};

/*
功能
把多个乐句拼接并冻结为不可变旋律序列。

调用方
MENU_MELODY、SQUAD_SELECTION_MELODY、DAWN_MELODY、DUSK_MELODY 常量初始化。

输入
任意数量的音符/休止符数组。

输出
冻结的扁平音符数组。

读取状态
无。

写入状态
无。

调用函数
Array.flat、Object.freeze。

边界与不变量
保持乐句和音符原顺序，不做复制以外的音乐变换。
*/
const longMelody = (...phrases) => Object.freeze(phrases.flat());

// 首页与说明书使用明快的 G 大调冒险主题；切分式拾音让旋律有桌游开场的轻盈推进感。
const MENU_MELODY = longMelody(
  [67, null, 71, null, 74, null, 79, 76, 74, null, 71, null, 69, null, 67, null],
  [69, null, 71, null, 74, null, 76, 74, 71, null, 69, null, 67, null, 66, null],
  [67, null, 69, null, 71, null, 74, 76, 79, null, 76, null, 74, null, 71, null],
  [72, null, 71, null, 69, null, 67, 69, 71, null, 74, null, 69, null, 66, null],
  [67, null, 71, null, 74, null, 79, 81, 79, null, 76, null, 74, null, 71, null],
  [69, null, 74, null, 76, null, 78, 79, 78, null, 76, null, 74, null, 71, null],
  [72, null, 76, null, 79, null, 83, 81, 79, null, 76, null, 74, null, 72, null],
  [71, null, 74, null, 79, null, 78, 76, 74, null, 71, null, 69, null, 66, null],
  [67, null, 69, null, 71, null, 74, 76, 74, null, 71, null, 67, null, 69, null],
  [71, null, 72, null, 74, null, 76, 78, 79, null, 78, null, 76, null, 74, null],
  [76, null, 79, null, 83, null, 81, 79, 76, null, 74, null, 72, null, 71, null],
  [69, null, 72, null, 76, null, 74, 71, 69, null, 67, null, 66, null, 69, null],
  [67, null, 71, null, 74, null, 79, 76, 74, null, 71, null, 69, null, 67, null],
  // 收尾停在属音 D4，循环回 G4 时形成自然的 V→I 开场衔接。
  [72, null, 71, null, 69, null, 67, 69, 71, null, 69, null, 66, null, 62, null]
);

// 选编队沿用修改前的稀疏五声音阶旋律；它必须与首页主题保持独立身份。
const SQUAD_SELECTION_MELODY = longMelody(
  [67, null, 71, null, 74, null, 71, null, 69, null, 67, null, 64, null, 62, null],
  [67, null, 69, null, 71, 74, 71, null, 69, null, 64, null, 62, null, 67, null],
  [71, null, 74, null, 79, null, 76, null, 74, null, 71, null, 69, null, 67, null],
  [64, null, 67, null, 71, null, 69, null, 67, null, 64, null, 62, null, 67, null],
  [69, null, 71, null, 74, null, 76, null, 74, null, 71, null, 67, null, 64, null],
  [67, null, 71, 74, 79, null, 76, null, 74, null, 71, null, 69, null, 67, null],
  [64, null, 67, null, 69, null, 71, null, 74, null, 71, null, 69, null, 64, null],
  [67, null, 64, null, 62, null, 64, null, 67, null, 69, null, 67, null, 62, null]
);

// 正式对局每个乐句16步、全曲12句，共192步；晨约74秒、昏约80秒才完成一次循环。
const DAWN_MELODY = longMelody(
  [60, null, 64, null, 67, null, 69, 67, 64, null, 62, null, 64, null, 67, null],
  [67, null, 69, 72, 69, null, 67, null, 64, 67, 64, null, 62, null, 60, null],
  [60, null, 64, null, 67, 69, 72, null, 69, 67, 64, null, 62, 64, 67, null],
  [64, null, 67, null, 72, 71, 69, null, 67, null, 64, 62, 64, null, 67, null],
  [69, 72, 74, null, 72, 69, 67, null, 64, 67, 69, null, 67, 64, 62, null],
  [67, null, 71, 72, 76, null, 74, 72, 69, null, 67, 64, 67, null, 69, null],
  [72, null, 76, 79, 76, null, 74, null, 72, 69, 67, null, 69, null, 72, null],
  [64, 67, 69, null, 72, null, 71, 69, 67, null, 64, 67, 69, null, 64, null],
  [60, 64, 67, 72, 71, null, 69, 67, 64, null, 67, 69, 72, null, 74, null],
  [69, null, 72, 74, 76, null, 74, 72, 69, 67, 64, null, 67, 69, 72, null],
  [72, null, 69, 67, 64, null, 62, 64, 67, 69, 67, null, 64, 62, 60, null],
  // 末句停在属音 G4：把收尾从“终止式”改成“导回开头”，循环回第一乐句的 C4 时形成 V→I 自然衔接。
  [67, 64, 62, null, 60, null, 64, 67, 69, null, 67, 64, 62, null, 67, null]
);

const DUSK_MELODY = longMelody(
  [57, null, 60, null, 64, null, 65, 64, 60, null, 57, null, 55, null, 53, null],
  [53, null, 57, 60, 57, null, 55, null, 52, 55, 57, null, 60, null, 57, null],
  [45, null, 52, 53, 57, null, 60, 57, 55, null, 52, 53, 55, null, 57, null],
  [60, 64, 65, null, 64, 60, 57, null, 55, 57, 60, null, 57, 55, 52, null],
  [52, null, 55, 57, 60, null, 64, 60, 57, null, 55, 52, 53, null, 55, null],
  [57, null, 60, 64, 65, null, 67, 65, 64, null, 60, 57, 60, null, 64, null],
  [64, null, 67, 69, 67, null, 65, 64, 60, null, 57, 55, 57, null, 60, null],
  [53, 57, 60, null, 64, null, 62, 60, 57, null, 53, 55, 57, null, 52, null],
  [45, 52, 57, 60, 59, null, 57, 53, 52, null, 55, 57, 60, null, 62, null],
  [60, null, 64, 65, 67, null, 65, 64, 60, 57, 55, null, 57, 60, 64, null],
  [64, null, 60, 57, 53, null, 52, 53, 55, 57, 55, null, 53, 52, 48, null],
  // 末句停在 A3：避免旋律跌到最低音 A2 再重新跳回，循环回第一乐句的 A3 时保持同一音区连续。
  [57, 53, 52, null, 48, null, 52, 55, 57, null, 55, 52, 50, null, 57, null]
);

export const MUSIC_PROFILES = Object.freeze({
  menu: Object.freeze({
    tempo: 102,
    lead: MENU_MELODY,
    bass: Object.freeze([43, 38, 40, 38, 43, 36, 40, 38, 43, 38, 40, 38, 36, 38, 43, 38, 40, 38, 43, 36, 40, 38, 43, 38, 36, 40, 38, 38]),
    thirds: Object.freeze([4, 4, 3, 4, 4, 4, 3, 4, 4, 4, 3, 4, 4, 4, 4, 4, 3, 4, 4, 4, 3, 4, 4, 4, 4, 3, 4, 4]),
    wave: "triangle",
    leadLevel: 0.032,
    padLevel: 0.014
  }),
  squadSelection: Object.freeze({
    tempo: 64,
    lead: SQUAD_SELECTION_MELODY,
    bass: Object.freeze([43, 40, 45, 38, 40, 43, 38, 38, 43, 40, 45, 38, 40, 43, 38, 38]),
    thirds: Object.freeze([4, 3, 4, 3, 3, 4, 3, 3, 4, 3, 4, 3, 3, 4, 3, 3]),
    wave: "sine",
    leadLevel: 0.026,
    padLevel: 0.016
  }),
  dawn: Object.freeze({
    tempo: 78,
    lead: DAWN_MELODY,
    // 尾段 G→C 改为 G→G：结束在属和弦上，跨循环点再解决到开头的 C。
    bass: Object.freeze([48, 45, 43, 48, 45, 50, 48, 43, 45, 48, 50, 47, 48, 45, 43, 50, 45, 48, 43, 47, 48, 45, 43, 43]),
    thirds: Object.freeze([4, 3, 4, 2, 4, 4, 3, 4, 3, 4, 4, 3, 4, 3, 4, 4, 3, 4, 2, 3, 4, 3, 4, 4]),
    wave: "triangle",
    leadLevel: 0.036,
    padLevel: 0.022
  }),
  dusk: Object.freeze({
    tempo: 72,
    lead: DUSK_MELODY,
    // 尾段 Dm→Am 改为 Dm→Dm：结束在下属和弦上，跨循环点再解决到开头的 Am。
    bass: Object.freeze([45, 41, 43, 40, 41, 45, 43, 40, 45, 41, 38, 43, 45, 40, 41, 43, 38, 45, 41, 40, 43, 41, 38, 38]),
    thirds: Object.freeze([3, 3, 4, 3, 3, 3, 4, 3, 3, 3, 3, 4, 3, 3, 3, 4, 3, 3, 4, 3, 4, 3, 3, 3]),
    wave: "sine",
    leadLevel: 0.042,
    padLevel: 0.028
  })
});

/*
功能
把 MIDI 音符编号转换为十二平均律频率。

调用方
SoundManager.tone。

输入
MIDI note 数值。

输出
以 A4=440Hz 为基准的频率。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
转换公式固定使用十二平均律，不承担输入范围校验。
*/
const midiToFrequency = (note) => 440 * (2 ** ((note - 69) / 12));

/*
功能
读取声音开关偏好并对不可用存储安全降级。

调用方
SoundManager 构造函数。

输入
无。

输出
除显式存储 off 外均返回 true。

读取状态
localStorage 的声音偏好键。

写入状态
无。

调用函数
localStorage.getItem。

边界与不变量
隐私模式或存储异常不得阻止本次会话使用声音。
*/
function safelyReadPreference() {
  try { return globalThis.localStorage?.getItem(STORAGE_KEY) !== "off"; }
  catch { return true; }
}

/*
功能
持久化声音开关偏好。

调用方
SoundManager.setEnabled。

输入
是否启用声音。

输出
无返回值。

读取状态
无。

写入状态
localStorage 的声音偏好键。

调用函数
localStorage.setItem。

边界与不变量
存储异常静默忽略，不能回滚当前会话设置。
*/
function safelyStorePreference(enabled) {
  try { globalThis.localStorage?.setItem(STORAGE_KEY, enabled ? "on" : "off"); }
  catch { /* 隐私模式或禁用存储时仍允许本次会话使用声音。 */ }
}

/*
功能
读取并校验持久化的音乐音量。

调用方
SoundManager 构造函数。

输入
无。

输出
[0, 1] 内音量；缺失、非法或读取失败时返回默认值。

读取状态
localStorage 的音乐音量键。

写入状态
无。

调用函数
localStorage.getItem、Number。

边界与不变量
空字符串和非有限值不得被解释为有效的零音量。
*/
function safelyReadMusicVolume() {
  try {
    const stored = globalThis.localStorage?.getItem(MUSIC_VOLUME_KEY);
    if (typeof stored !== "string" || stored.trim() === "") return DEFAULT_MUSIC_VOLUME;
    const volume = Number(stored);
    return Number.isFinite(volume) && volume >= 0 && volume <= 1 ? volume : DEFAULT_MUSIC_VOLUME;
  } catch { return DEFAULT_MUSIC_VOLUME; }
}

/*
功能
读取并校验持久化的音效音量。

调用方
SoundManager 构造函数。

输入
无。

输出
[0, 1] 内音量；缺失、非法或读取失败时返回默认值。

读取状态
localStorage 的音效音量键。

写入状态
无。

调用函数
localStorage.getItem、Number。

边界与不变量
空字符串和非有限值不得被解释为有效的零音量。
*/
function safelyReadSfxVolume() {
  try {
    const stored = globalThis.localStorage?.getItem(SFX_VOLUME_KEY);
    if (typeof stored !== "string" || stored.trim() === "") return DEFAULT_SFX_VOLUME;
    const volume = Number(stored);
    return Number.isFinite(volume) && volume >= 0 && volume <= 1 ? volume : DEFAULT_SFX_VOLUME;
  } catch { return DEFAULT_SFX_VOLUME; }
}

/*
功能
持久化归一化音乐音量。

调用方
SoundManager.setMusicVolume。

输入
已归一化的音量数值。

输出
无返回值。

读取状态
无。

写入状态
localStorage 的音乐音量键。

调用函数
localStorage.setItem。

边界与不变量
存储异常静默忽略，当前 AudioContext 设置仍然生效。
*/
function safelyStoreMusicVolume(volume) {
  try { globalThis.localStorage?.setItem(MUSIC_VOLUME_KEY, String(volume)); }
  catch { /* 存储不可用时只保留本次会话设置。 */ }
}

/*
功能
持久化归一化音效音量。

调用方
SoundManager.setSfxVolume。

输入
已归一化的音量数值。

输出
无返回值。

读取状态
无。

写入状态
localStorage 的音效音量键。

调用函数
localStorage.setItem。

边界与不变量
存储异常静默忽略，当前 AudioContext 设置仍然生效。
*/
function safelyStoreSfxVolume(volume) {
  try { globalThis.localStorage?.setItem(SFX_VOLUME_KEY, String(volume)); }
  catch { /* 存储不可用时只保留本次会话设置。 */ }
}

export class SoundManager {
  /*
  功能
  创建延迟解锁的 Web Audio 声音与音乐控制器。

  调用方
  UIManager 构造函数。

  输入
  无。

  输出
  SoundManager 实例。

  读取状态
  已持久化的声音开关、音乐音量和音效音量。

  写入状态
  初始化 AudioContext、调度器、缓存和节流生命周期字段。

  调用函数
  safelyReadPreference、safelyReadMusicVolume、safelyReadSfxVolume。

  边界与不变量
  构造时不得创建 AudioContext，必须等待用户交互解锁。
  */
  constructor() {
    this.enabled = safelyReadPreference();
    this.musicVolume = safelyReadMusicVolume();
    this.sfxVolume = safelyReadSfxVolume();
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
    this.musicStepsByTeam = { menu: 0, squadSelection: 0, dawn: 0, dusk: 0 };
    this.musicSources = new Set();
    this.lightningBuffer = null;
    this.lightningBufferPromise = null;
    this.lastPlayedAt = new Map();
  }

  /*
  功能
  判断当前浏览器是否提供 Web Audio 上下文。

  调用方
  SoundManager.unlock 与 UI 能力检测。

  输入
  无。

  输出
  支持 AudioContext 或 webkitAudioContext 时返回 true。

  读取状态
  globalThis AudioContext 能力。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  只做能力检测，不创建音频节点。
  */
  get isSupported() {
    return Boolean(globalThis.AudioContext || globalThis.webkitAudioContext);
  }

  /*
  功能
  在用户交互后创建或恢复 AudioContext 并启动已选择的 BGM。

  调用方
  UI 启动交互、setEnabled、setMusicTeam 与 play。

  输入
  无。

  输出
  AudioContext 进入 running 状态时解析为 true。

  读取状态
  enabled、isSupported、context 与 musicTeam。

  写入状态
  延迟创建/恢复音频图并可能启动调度器和雷击采样预载。

  调用函数
  createGraph、AudioContext.resume、startScheduler、loadLightningBuffer。

  边界与不变量
  未启用或不支持时不得创建上下文；采样预载不能阻塞解锁结果。
  */
  async unlock() {
    if (!this.enabled || !this.isSupported) return false;
    try {
      if (!this.context) this.createGraph();
      if (this.context.state === "suspended") await this.context.resume();
    } catch {
      // autoplay 拒绝或上下文初始化失败是浏览器策略下的正常锁定状态；保留 musicTeam，等待下一次交互重试。
      return false;
    }
    if (this.musicTeam) this.startScheduler();
    // 首次解锁后后台预加载真实雷击采样，避免第一声闪电因 fetch+decode 明显延迟。
    if (!this.lightningBuffer && !this.lightningBufferPromise) void this.loadLightningBuffer();
    return this.context.state === "running";
  }

  /*
  功能
  创建 SFX/BGM 分路并连接到浏览器音频输出。

  调用方
  SoundManager.unlock 首次解锁路径。

  输入
  无。

  输出
  无返回值。

  读取状态
  enabled、musicVolume 与 sfxVolume。

  写入状态
  context、masterGain、sfxGain、musicGain 及节点连接。

  调用函数
  AudioContext、musicGainForVolume。

  边界与不变量
  每个 SoundManager 只应创建一张音频图；音乐和音效必须经 masterGain 汇合。
  */
  createGraph() {
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    this.context = new AudioContextClass();
    this.masterGain = this.context.createGain();
    this.sfxGain = this.context.createGain();
    this.musicGain = this.context.createGain();
    this.masterGain.gain.value = this.enabled ? 0.82 : 0;
    this.sfxGain.gain.value = SFX_GAIN_BASE * this.sfxVolume;
    this.musicGain.gain.value = musicGainForVolume(this.musicVolume);
    this.sfxGain.connect(this.masterGain);
    this.musicGain.connect(this.masterGain);
    this.masterGain.connect(this.context.destination);
  }

  /*
  功能
  切换声音总开关并平滑更新主增益。

  调用方
  UIManager.toggleAudio。

  输入
  新的启用状态。

  输出
  归一化后的 enabled 布尔值。

  读取状态
  context、masterGain 与现有 enabled。

  写入状态
  enabled、持久化偏好、主增益与音乐调度器状态。

  调用函数
  safelyStorePreference、unlock、stopScheduler、play。

  边界与不变量
  关闭只静音并停止排程，不销毁 AudioContext；开启提示音必须绕过普通 enabled 节流。
  */
  async setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    safelyStorePreference(this.enabled);
    if (this.enabled) {
      await this.unlock();
      if (this.masterGain) this.masterGain.gain.setTargetAtTime(0.82, this.context.currentTime, 0.035);
      this.play("select", { force: true });
    } else {
      this.stopScheduler();
      if (this.masterGain) this.masterGain.gain.setTargetAtTime(0.0001, this.context.currentTime, 0.025);
    }
    return this.enabled;
  }

  /*
  功能
  设置并持久化 BGM 音量。

  调用方
  UIManager.setMusicVolume。

  输入
  可转换为数值的音量。

  输出
  限制在 [0, 1] 的音量。

  读取状态
  context 与 musicGain。

  写入状态
  musicVolume、持久化值与当前音乐增益。

  调用函数
  safelyStoreMusicVolume、musicGainForVolume。

  边界与不变量
  非数值按零处理；已有节点使用短时间平滑过渡。
  */
  setMusicVolume(volume) {
    const normalized = Math.min(1, Math.max(0, Number(volume) || 0));
    this.musicVolume = normalized;
    safelyStoreMusicVolume(normalized);
    if (this.musicGain && this.context) {
      this.musicGain.gain.setTargetAtTime(musicGainForVolume(normalized), this.context.currentTime, 0.025);
    }
    return normalized;
  }

  /*
  功能
  设置并持久化非 BGM 音效总音量。

  调用方
  UIManager.setSfxVolume。

  输入
  可转换为数值的音量。

  输出
  限制在 [0, 1] 的音量。

  读取状态
  context 与 sfxGain。

  写入状态
  sfxVolume、持久化值与当前音效总增益。

  调用函数
  safelyStoreSfxVolume。

  边界与不变量
  非数值按零处理；已有节点使用短时间平滑过渡。
  */
  setSfxVolume(volume) {
    const normalized = Math.min(1, Math.max(0, Number(volume) || 0));
    this.sfxVolume = normalized;
    safelyStoreSfxVolume(normalized);
    if (this.sfxGain && this.context) {
      this.sfxGain.gain.setTargetAtTime(SFX_GAIN_BASE * normalized, this.context.currentTime, 0.025);
    }
    return normalized;
  }

  /*
  功能
  选择统一 BGM profile，并在主题切换时续接各自播放进度。

  调用方
  UIManager.setMusicTeam、playMenuMusic、playSquadSelectionMusic 与对局展示流程。

  输入
  menu/squadSelection/dawn/dusk 主题 ID，以及是否立即尝试解锁 AudioContext 的内部选项；未知主题表示停止音乐。

  输出
  有效主题 ID；未知主题走 stopMusic 返回值。

  读取状态
  MUSIC_PROFILES、musicTeam、musicStep 与 musicStepsByTeam。

  写入状态
  当前主题、步进位置、调度时钟和活跃音乐节点。

  调用函数
  stopMusic、stopMusicSources、stopScheduler、unlock。

  边界与不变量
  同主题重复设置不得重置进度；切换时旧主题不能叠音。
  */
  setMusicTeam(team, options = {}) {
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
    if (this.enabled && options.unlock !== false) void this.unlock();
    return team;
  }

  /*
  功能
  选择首页/说明书 BGM，并复用统一音乐主题的幂等与续播生命周期。

  调用方
  UIManager 的开始页与说明书展示入口。

  输入
  无。

  输出
  menu 音乐主题 ID。

  读取状态
  SoundManager 当前音乐主题。

  写入状态
  仅在离开其他主题时切换到 menu；重复请求保持当前调度进度。

  调用函数
  setMusicTeam。

  边界与不变量
  首页与说明书共用 menu；进入页面立即尝试解锁，autoplay 被阻止时保留主题并由后续交互重试；重复进入不得重启 scheduler 或重置 musicStep。
  */
  playMenuMusic() {
    return this.setMusicTeam("menu");
  }

  /*
  功能
  选择选编队页面的原有 BGM，并保持独立的续播进度。

  调用方
  UIManager.showSquadSelection 与 UIManager.showSelection。

  输入
  无。

  输出
  squadSelection 音乐主题 ID。

  读取状态
  SoundManager 当前音乐主题。

  写入状态
  仅在离开其他主题时切换到 squadSelection；重复请求保持当前调度进度。

  调用函数
  setMusicTeam。

  边界与不变量
  选编队曲目不得与首页/说明书 menu profile 共用身份或旋律。
  */
  playSquadSelectionMusic() {
    return this.setMusicTeam("squadSelection");
  }

  /*
  功能
  停止当前 BGM 并保存其续接步进。

  调用方
  UIManager.showGame 与 setMusicTeam 的无效主题路径。

  输入
  无。

  输出
  无返回值。

  读取状态
  musicTeam、musicStep。

  写入状态
  保存阵营步进并清空当前主题和调度器。

  调用函数
  stopMusicSources、stopScheduler。

  边界与不变量
  停止后不得继续排程或保留当前主题。
  */
  stopMusic() {
    if (this.musicTeam) this.musicStepsByTeam[this.musicTeam] = this.musicStep;
    this.stopMusicSources();
    this.musicTeam = null;
    this.stopScheduler();
  }

  /*
  功能
  淡出并释放已提前排程但仍存活的音乐 gain 节点。

  调用方
  setMusicTeam、stopMusic。

  输入
  无。

  输出
  无返回值。

  读取状态
  musicSources 与 context.currentTime。

  写入状态
  取消节点增益排程、启动短淡出并清空 musicSources。

  调用函数
  AudioParam.cancelScheduledValues、setTargetAtTime。

  边界与不变量
  节点已自然结束时安全忽略；主题切换不得出现新旧 BGM 叠音或硬截断。
  */
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

  /*
  功能
  启动 BGM 前瞻调度循环。

  调用方
  unlock。

  输入
  无。

  输出
  无返回值。

  读取状态
  musicTimer、context 状态、musicTeam 与 nextMusicTime。

  写入状态
  校准 nextMusicTime 并创建 musicTimer。

  调用函数
  scheduleMusic、globalThis.setInterval。

  边界与不变量
  同一实例至多一个 timer；上下文未 running 或无主题时不得启动。
  */
  startScheduler() {
    if (this.musicTimer || !this.context || this.context.state !== "running" || !this.musicTeam) return;
    this.nextMusicTime = Math.max(this.context.currentTime + 0.02, this.nextMusicTime);
    this.scheduleMusic();
    this.musicTimer = globalThis.setInterval(() => this.scheduleMusic(), 250);
  }

  /*
  功能
  停止 BGM 前瞻调度 timer。

  调用方
  setEnabled、setMusicTeam、stopMusic。

  输入
  无。

  输出
  无返回值。

  读取状态
  musicTimer。

  写入状态
  清除并置空 musicTimer。

  调用函数
  globalThis.clearInterval。

  边界与不变量
  可重复调用；已排程节点由 stopMusicSources 单独管理。
  */
  stopScheduler() {
    if (this.musicTimer) globalThis.clearInterval(this.musicTimer);
    this.musicTimer = null;
  }

  /*
  功能
  把当前主题的音符持续排程到固定前瞻窗口。

  调用方
  startScheduler 的立即调用与 interval tick。

  输入
  无。

  输出
  无返回值。

  读取状态
  MUSIC_PROFILES、context.currentTime、musicTeam、musicStep 与 nextMusicTime。

  写入状态
  推进 musicStep 与 nextMusicTime。

  调用函数
  scheduleMusicStep。

  边界与不变量
  未启用、无主题或 context 非 running 时不得推进步进。
  */
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

  /*
  功能
  为单个音乐步进排程主旋律、和声和阵营装饰音。

  调用方
  scheduleMusic。

  输入
  音乐 profile、绝对步进、开始时间与步长秒数。

  输出
  无返回值。

  读取状态
  profile 音符/和声配置与 musicTeam。

  写入状态
  通过 tone 创建并登记 Web Audio 节点。

  调用函数
  tone。

  边界与不变量
  休止符不创建旋律节点；取模顺序与既有循环节拍必须保持稳定。
  */
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

  /*
  功能
  播放一个命名 SFX；lightning 走采样路径，UI select 保留短节流，其余 gameplay 音效不被节流吞掉。

  调用方
  UIManager 与 gameplay feedback adapters。

  输入
  name 与可选 force 选项。

  输出
  是否实际触发声音节点；未启用、解锁失败或未知名称返回 false。

  读取状态
  enabled、context、lastPlayedAt 与 SOUND_THROTTLE_MS。

  写入状态
  lastPlayedAt 与 Web Audio 节点。

  调用函数
  unlock、playLightningSample 与 sound_* 方法。

  边界与不变量
  force 只绕过 enabled 与节流；不会绕过 AudioContext 解锁。
  */
  async play(name, options = {}) {
    if (!this.enabled && !options.force) return false;
    if (!await this.unlock()) return false;
    if (name === "lightning") return this.playLightningSample();
    const throttle = SOUND_THROTTLE_MS[name] ?? 0;
    const nowMs = globalThis.performance?.now?.() ?? Date.now();
    if (!options.force && nowMs - (this.lastPlayedAt.get(name) ?? -Infinity) < throttle) return false;
    this.lastPlayedAt.set(name, nowMs);
    const method = this[`sound_${name}`];
    if (typeof method !== "function") return false;
    method.call(this, this.context.currentTime + 0.008);
    return true;
  }

  /*
  功能
  加载、解码并缓存真实雷击采样。

  调用方
  unlock 后台预载与 playLightningSample。

  输入
  无。

  输出
  解析为 AudioBuffer；请求或解码失败时解析为 null。

  读取状态
  lightningBuffer、lightningBufferPromise、context 与 LIGHTNING_SOURCE。

  写入状态
  缓存 buffer 或进行中的 Promise；失败后清除 Promise 以允许重试。

  调用函数
  fetch、AudioContext.decodeAudioData、Debug.log。

  边界与不变量
  并发调用共享同一 Promise；失败静默降级为本次雷击无声，不得阻塞游戏流程。
  */
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

  /*
  功能
  播放一次真实雷击采样。

  调用方
  SoundManager.play 的 lightning 分支。

  输入
  无。

  输出
  成功建立播放节点时解析为 true，否则 false。

  读取状态
  enabled、context、lightningBuffer 与 sfxGain。

  写入状态
  创建一次性 BufferSource 和局部 GainNode。

  调用函数
  loadLightningBuffer、Web Audio 节点 API。

  边界与不变量
  每次命中使用独立 source；未解锁、禁用或采样失败时不得创建播放节点。
  */
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

  /*
  功能
  创建带包络的单个振荡器音符。

  调用方
  BGM 排程与 sound_skill/sound_heal/sound_shield。

  输入
  MIDI 音符、时间、时长、波形、增益、目标节点、attack 与是否跟踪。

  输出
  无返回值。

  读取状态
  context 与默认 sfxGain。

  写入状态
  创建/排程 oscillator 和 gain；tracked 时登记 musicSources。

  调用函数
  midiToFrequency、Web Audio Oscillator/Gain API。

  边界与不变量
  gain 全程保持正值以满足指数 ramp；tracked 节点结束后必须移出 musicSources。
  */
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

  /*
  功能
  创建从起始频率滑向结束频率的短音效。

  调用方
  sound_hit、sound_discard。

  输入
  起止 Hz、时间、时长、波形与增益。

  输出
  无返回值。

  读取状态
  context 与 sfxGain。

  写入状态
  创建并排程 oscillator 和 gain 节点。

  调用函数
  Web Audio Oscillator/Gain API。

  边界与不变量
  起止频率必须为正；节点在包络结束后及时停止。
  */
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

  /*
  功能
  播放可选滤波的白噪声包络。

  调用方
  sound_draw、sound_hit、sound_discard。

  输入
  时间、时长、增益、可选滤波频率/类型与 attack。

  输出
  无返回值。

  读取状态
  context、sfxGain 与缓存 noiseBuffer。

  写入状态
  首次生成白噪声缓存并创建一次性 source/filter/gain 节点。

  调用函数
  Math.random、Web Audio Buffer/Filter/Gain API。

  边界与不变量
  随机噪声仅用于音效，不能与游戏或 AI RNG 共享；包络 attack 不得超过时长四分之一。
  */
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

  /*
  功能
  播放低通棕噪声脉冲作为纸牌与轻触反馈。

  调用方
  sound_select、sound_playCard。

  输入
  时间、时长、增益、低通截止频率与 attack。

  输出
  无返回值。

  读取状态
  context、sfxGain 与缓存 softNoiseBuffer。

  写入状态
  首次生成棕噪声缓存并创建一次性 source/filter/gain 节点。

  调用函数
  Math.random、Web Audio Buffer/Filter/Gain API。

  边界与不变量
  随机源只塑造音色；反馈不得产生持续音高，attack 不得超过时长五分之一。
  */
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

  /*
  功能
  合成 UI 选择轻触音效。

  调用方
  SoundManager.play 的 select 名称分派。

  输入
  Web Audio 开始时间。

  输出
  无返回值。

  读取状态
  SoundManager 音频图。

  写入状态
  创建一次 softNoise 音效节点。

  调用函数
  softNoise。

  边界与不变量
  select 节流由 play 统一处理；局部 gain 只影响 UI 点击，不改变其它 SFX 总增益。
  */
  sound_select(time) {
    // UI 点击需要在正常 BGM 下清晰可辨；只提升本 profile，不放大全部游戏 SFX。
    this.softNoise(time, 0.032, 0.12, 680, 0.003);
  }

  /*
  功能
  合成短促 UI 点击与轻微纸牌触感叠加的选择音效。

  调用方
  SoundManager.play 的 cardSelect 名称分派。

  输入
  Web Audio 开始时间。

  输出
  无返回值。

  读取状态
  SoundManager 音频图。

  写入状态
  创建两段经 sfxGain 输出的 softNoise 音效节点。

  调用函数
  softNoise。

  边界与不变量
  每次有效卡牌点击由 Presentation 边界调用一次；不得连接 musicGain；两层局部目标增益合计保持在 0.14，避免叠加削波。
  */
  sound_cardSelect(time) {
    this.softNoise(time, 0.038, 0.8, 760, 0.003);
    this.softNoise(time + 0.018, 0.045, 0.055, 430, 0.004);
  }

  /*
  功能
  合成两段纸张摩擦的摸牌音效。

  调用方
  SoundManager.play 的 draw 名称分派。

  输入
  Web Audio 开始时间。

  输出
  无返回值。

  读取状态
  SoundManager 音频图。

  写入状态
  创建两段 noise 音效节点。

  调用函数
  noise。

  边界与不变量
  两段相对时间和低通参数共同定义既有可听节奏。
  */
  sound_draw(time) {
    // 两段短促的低通纸张摩擦；不使用持续振荡器，彻底避免飞虫般的嗡鸣和尖锐滑音。
    this.noise(time, 0.075, 0.038, 820, "lowpass", 0.014);
    this.noise(time + 0.052, 0.09, 0.026, 620, "lowpass", 0.018);
  }

  /*
  功能
  合成先轻擦后落桌的出牌音效。

  调用方
  SoundManager.play 的 playCard 名称分派。

  输入
  Web Audio 开始时间。

  输出
  无返回值。

  读取状态
  SoundManager 音频图。

  写入状态
  创建两段 softNoise 音效节点。

  调用函数
  softNoise。

  边界与不变量
  不复用尖锐白噪声；两段相对时序保持既有落牌质感。
  */
  sound_playCard(time) {
    // 全新的低频棕噪声落牌：先轻擦、后轻落，不复用容易产生尖锐感的白噪声声源。
    this.softNoise(time, 0.045, 0.065, 440, 0.006);
    this.softNoise(time + 0.038, 0.065, 0.075, 240, 0.004);
  }

  /*
  功能
  合成噪声冲击与低频下滑组成的受击音效。

  调用方
  SoundManager.play 的 hit 名称分派。

  输入
  Web Audio 开始时间。

  输出
  无返回值。

  读取状态
  SoundManager 音频图。

  写入状态
  创建 noise 与 sweep 音效节点。

  调用函数
  noise、sweep。

  边界与不变量
  两层音效从同一事件时间开始，不改变伤害结算时序。
  */
  sound_hit(time) {
    this.noise(time, 0.13, 0.2, 180);
    this.sweep(118, 48, time, 0.23, "sine", 0.2);
  }

  /*
  功能
  合成递进琶音的技能音效。

  调用方
  SoundManager.play 的 skill 名称分派。

  输入
  Web Audio 开始时间。

  输出
  无返回值。

  读取状态
  固定音符序列与 SoundManager 音频图。

  写入状态
  创建四个 tone 节点。

  调用函数
  tone。

  边界与不变量
  音符顺序和 55ms 间隔保持固定。
  */
  sound_skill(time) {
    [64, 68, 71, 76].forEach((note, index) => this.tone(note, time + index * 0.055, 0.38, index % 2 ? "sine" : "triangle", 0.095));
  }

  /*
  功能
  合成噪声与下滑音组成的弃牌音效。

  调用方
  SoundManager.play 的 discard 名称分派。

  输入
  Web Audio 开始时间。

  输出
  无返回值。

  读取状态
  SoundManager 音频图。

  写入状态
  创建 noise 与 sweep 音效节点。

  调用函数
  noise、sweep。

  边界与不变量
  音效不参与牌区移动或弃牌顺序。
  */
  sound_discard(time) {
    this.noise(time, 0.2, 0.075, 700);
    this.sweep(520, 155, time, 0.22, "triangle", 0.07);
  }

  /*
  功能
  合成上行琶音的治疗音效。

  调用方
  SoundManager.play 的 heal 名称分派。

  输入
  Web Audio 开始时间。

  输出
  无返回值。

  读取状态
  固定音符序列与 SoundManager 音频图。

  写入状态
  创建四个 tone 节点。

  调用函数
  tone。

  边界与不变量
  音符顺序和 70ms 间隔保持固定。
  */
  sound_heal(time) {
    [60, 64, 67, 72].forEach((note, index) => this.tone(note, time + index * 0.07, 0.42, "sine", 0.085));
  }

  /*
  功能
  合成三层持续音组成的护盾音效。

  调用方
  SoundManager.play 的 shield 名称分派。

  输入
  Web Audio 开始时间。

  输出
  无返回值。

  读取状态
  SoundManager 音频图。

  写入状态
  创建三个错峰 tone 节点。

  调用函数
  tone。

  边界与不变量
  三层相对时间、音高和响度共同定义既有音色。
  */
  sound_shield(time) {
    this.tone(55, time, 0.52, "triangle", 0.11);
    this.tone(62, time + 0.018, 0.58, "sine", 0.075);
    this.tone(74, time + 0.05, 0.44, "sine", 0.045);
  }
}
