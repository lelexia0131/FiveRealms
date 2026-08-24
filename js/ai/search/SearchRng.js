/*
模块职责
拥有 AI Search/Decision 专用可复现 RNG；与真实 Game RNG 完全分离，并可为 SearchRequest 提供稳定 seed 事实。

上游
MatchApplication composition root 与 AIController。

下游
Probability hidden-world sampling、CardSelectionPolicy 与其它明确 exploration consumer 的 AI 随机消费。

状态边界
只写本实例 seed 与调用计数；不写 GameState 或 World。

信息边界
不读取隐藏信息，不解释随机用途。

架构约束
不得依赖 Game/Application/Domain；不得使用 Math.random；不得被真实 Game 结算使用。
*/

/*
功能
把任意字符串投影为 32 位 LCG seed。

调用方
createSearchRng 默认 seed 推导。

输入
字符串。

输出
32 位非负整数。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
只使用确定 FNV-1a；空字符串也返回稳定 seed。
*/
export function hashSearchSeed(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < String(text ?? "").length; index += 1) {
    hash ^= String(text).charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export class SearchRng {
  /*
  功能
  创建与真实 Game RNG 隔离的 AI search RNG。

  调用方
  MatchApplication composition root、AIController 与 RNG 隔离测试。

  输入
  数值 seed。

  输出
  可 next() 的 SearchRng 实例。

  读取状态
  无。

  写入状态
  初始化 seed 与 draws。

  调用函数
  Number。

  边界与不变量
  使用固定 LCG；两次相同 seed 产生相同序列；不读取或推进 Game RNG。
  */
  constructor(seedValue) {
    this.seed = (Number(seedValue) || 0) >>> 0;
    this.state = this.seed;
    this.draws = 0;
  }

  /*
  功能
  返回下一个零到一之间的确定随机数。

  调用方
  AIController 注入的 AI random 能力。

  输入
  无。

  输出
  零到一之间的数值。

  读取状态
  本实例 state 与 draws。

  写入状态
  state 推进一次，draws 加一。

  调用函数
  Math.imul。

  边界与不变量
  每次调用只推进本实例；序列与真实 Game RNG 无共享状态。
  */
  next() {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    this.draws += 1;
    return this.state / 4294967296;
  }

  /*
  功能
  返回 SearchRequest 可序列化的 RNG 事实。

  调用方
  SearchRequest 构造。

  输入
  无。

  输出
  { seed, algorithm, draws }。

  读取状态
  本实例 seed 与 draws。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  不返回函数或可变 state；draws 是创建请求时的诊断事实。
  */
  snapshot() {
    return { seed:this.seed, state:this.state, algorithm:"lcg", draws:this.draws };
  }

  /*
  功能
  从 snapshot 创建恢复同一 continuation 的 SearchRng。

  调用方
  Worker search runtime 与 RNG handoff 测试。

  输入
  snapshot（seed/state/draws/algorithm）。

  输出
  与 snapshot 后续序列一致的 SearchRng。

  读取状态
  无。

  写入状态
  新实例 state 与 draws。

  调用函数
  Number。

  边界与不变量
  常数时间恢复；不创建全局 RNG 或读取旧 session。
  */
  static restore(snapshot) {
    if (!snapshot || snapshot.algorithm !== "lcg") throw new TypeError("SearchRng snapshot 只接受 lcg continuation");
    const rng = new SearchRng(snapshot.seed);
    rng.state = (Number(snapshot.state) || 0) >>> 0;
    rng.draws = Math.max(0, Number(snapshot.draws) || 0);
    return rng;
  }

  /*
  功能
  提交一次 Worker search 产生的 rngAfter continuation。

  调用方
  main-thread AIController RNG commit boundary。

  输入
  snapshot。

  输出
  无。

  读取状态
  无。

  写入状态
  本实例 state 与 draws。

  调用函数
  Number。

  边界与不变量
  只允许 caller 显式 exactly-once commit；本方法不判断 request 重复。
  */
  commit(snapshot) {
    if (!snapshot || snapshot.algorithm !== "lcg") throw new TypeError("SearchRng commit 只接受 lcg continuation");
    this.seed = (Number(snapshot.seed) || 0) >>> 0;
    this.state = (Number(snapshot.state) || 0) >>> 0;
    this.draws = Math.max(0, Number(snapshot.draws) || 0);
  }
}
