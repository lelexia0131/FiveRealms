/**
 * 可跟踪的确定性随机源。
 * 与 tests/balance.mjs 使用同一 LCG，但额外暴露当前状态，
 * 供成对实验在分叉点以完全相同的内状态创建两条分支。
 */
export class TrackedRng {
  constructor(seedValue) {
    this.state = Number(seedValue) >>> 0;
  }

  next() {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state / 4294967296;
  }

  snapshot() {
    return this.state;
  }

  static from(state) {
    const rng = new TrackedRng(0);
    rng.state = Number(state) >>> 0;
    return rng;
  }
}

export function makeRandom(seedValue) {
  return new TrackedRng(seedValue);
}
