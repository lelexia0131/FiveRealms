/*
模块职责
唯一拥有雷达防御与延迟状态判定的纯结果解释；不执行抽牌、UI、事件或移动。

上游
JudgmentSystem 与 tests。

下游
无。

状态边界
只读传入 category/triggerCategory；不写状态。

信息边界
不读取 AI/UI/隐藏信息。

架构约束
不得依赖 application/adapters/Game runtime；不得 await、emit、随机。
*/

/*
功能
解释雷达防御判定的 category 结果。

调用方
JudgmentSystem.judgeDefense。

输入
判定卡 category。

输出
handled/immune 与结果 category。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
战术免疫、基础继续、装备继续。
*/
export function interpretDefenseJudgment(category) {
  if (category === "tactic") return { handled: true, immune: true, category };
  return { handled: true, immune: false, category };
}

/*
功能
解释延迟状态判定的触发结果。

调用方
JudgmentSystem.judgeDelayedStatus。

输入
判定卡 category 与触发 category。

输出
是否触发。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
只比较 category。
*/
export function interpretDelayedStatusJudgment(category, triggerCategory) {
  return category === triggerCategory;
}
