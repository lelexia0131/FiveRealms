/*
模块职责
定义 Application 的 minimal Random boundary：只暴露 next()；Domain 不得依赖本 port。

上游
match application composition root 与 random consumers。

下游
concrete random source（当前为 Game constructor 注入的函数）。

状态边界
不保存或写入状态。

信息边界
不解释随机用途。

架构约束
不得依赖 UI/AI/Audio/Diagnostics、Game runtime 或 Domain transitions。
*/

/*
功能
创建并验证 minimal RandomPort。

调用方
Game 构造函数。

输入
注入的 next 能力。

输出
冻结 { next } port。

读取状态
无。

写入状态
无。

调用函数
Object.freeze。

边界与不变量
不提供 randomInt/shuffle/choose 等无证据工具箱；每次 next 直接对应旧 random() 调用。
*/
export function createRandomPort({ next }) {
  if (typeof next !== "function") throw new TypeError("RandomPort 需要 next()");
  return Object.freeze({ next });
}
