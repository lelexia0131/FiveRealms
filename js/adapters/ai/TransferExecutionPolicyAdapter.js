/*
模块职责
拥有 AI 转移执行策略的 narrow adapter authority：禁止 AI 主动把己方手牌转移给敌方；不拥有 Application preparation、Domain legality 或 planner 策略。

上游
Game temporary composition root。

下游
Application CardIntentRuntime。

状态边界
只读 source/from/receiver 的 controllerType 与 battleTeam；不写状态。

信息边界
不读取 AI memory、Planner、SearchState 或 hidden card。

架构约束
不得依赖 Game、AIController、Planner、Domain transitions 或其它 adapter。
*/

/*
功能
判断 AI 来源→敌方接收者的转移是否允许执行。

调用方
Game composition 注入 CardIntentRuntime。

输入
source、from 与 receiver。

输出
布尔值。

读取状态
controllerType 与 battleTeam。

写入状态
无。

调用函数
无。

边界与不变量
真人路径恒允许；AI 己方→敌方恒拒绝；该公式不再复制进 Application 或 Domain。
*/
export function isTransferExecutionAllowed(source, from, receiver) {
  return !(source?.controllerType === "ai"
    && from?.battleTeam === source.battleTeam
    && receiver?.battleTeam !== source.battleTeam);
}
