/**
 * study-only 确定性随机环境。
 *
 * 不改动任何 js/ 业务代码，仅在 Worker 内按 job 安装：
 * - Math.random：LCG（与 TrackedRng 同参数），种子来自 job.seed；
 * - Date.now：每 job 固定基址 + 调用序号递增，使 createId 的 ID 序列可复现，
 *   从而消除 transferScoring 等以 ID 字符串做 tie-break 的跨进程不确定性。
 *
 * 配对边界与 TrackedRng 一致：runStateJob 在 rng.snapshot() 同一位置取
 * Math.random snapshot，Control 与每个 Experiment 分支前 restore 同一状态。
 */

const CLOCK_BASE = 1786000000000;
const CLOCK_STEP_MS = 13;
const LCG_MULTIPLIER = 1664525;
const LCG_INCREMENT = 1013904223;

export class StudyRandom {
  constructor(seedValue, clockBase) {
    this.state = Number(seedValue) >>> 0;
    this.clockBase = Number(clockBase) >>> 0;
    this.clockCalls = 0;
  }

  next() {
    this.state = (Math.imul(this.state, LCG_MULTIPLIER) + LCG_INCREMENT) >>> 0;
    return this.state / 4294967296;
  }

  nextClock() {
    return this.clockBase + (this.clockCalls++) * CLOCK_STEP_MS;
  }

  snapshot() {
    return { random: this.state, clock: this.clockCalls };
  }

  restore(snapshotValue) {
    this.state = Number(snapshotValue?.random) >>> 0;
    this.clockCalls = Number(snapshotValue?.clock) >>> 0;
  }
}

let current = null;

export function getStudyRandom() {
  return current?.random ?? null;
}

export function installJobRandom(job) {
  const seed = Number(job?.seed) >>> 0;
  const clockBase = CLOCK_BASE + (seed % 100000000);
  const random = new StudyRandom((seed ^ 0x9e3779b9) >>> 0, clockBase);
  current = { random };
  const saved = {
    dateNow: Date.now.bind(Date),
    mathRandom: Math.random.bind(Math)
  };
  Date.now = () => current.random.nextClock();
  Math.random = () => current.random.next();
  return saved;
}

export function uninstallJobRandom(saved) {
  Date.now = saved.dateNow;
  Math.random = saved.mathRandom;
  current = null;
}
