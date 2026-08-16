/*
模块职责
唯一拥有 Deck 中已证明属于 Domain 的牌区数组初始化 shape；重洗计数属于 diagnostics/test observability，不在此维护。

上游
Deck constructor 的 legacy composition 与未来 domain/state/transitions consumer。

下游
无。

状态边界
工厂只创建空牌区数组，不执行任何移动或洗牌。

信息边界
纯公开牌区状态 shape，无隐藏信息。

架构约束
不得依赖 application/adapters/ui/audio/ai/Game runtime；不得实现 draw/discard/judgment mutation。
*/

/*
功能
创建 Domain 牌区状态的初始空数组。

调用方
Deck constructor 按旧 key order 逐字段赋值。

输入
无。

输出
冻结的 zone state 初始字段对象。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
四个牌区数组保持可变，调用方必须继续使用同一数组身份；本工厂不共享跨 Deck 状态，也不拥有诊断计数。
*/
export function createDeckZoneState() {
  return Object.freeze({
    cards: [],
    discardPile: [],
    resolvingCards: [],
    judgmentZone: []
  });
}
