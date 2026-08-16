/*
模块职责
把 AI 转移方向 strategic prohibition 从正式 TransferPolicy 桥接给 Application 执行边界；不拥有转移策略公式。

上游
Game temporary composition root。

下游
Application CardIntentRuntime。

状态边界
只读 source/from/receiver 的 controllerType 与 battleTeam；不写状态。

信息边界
不读取 AI memory、Planner、SearchState 或 hidden card。

架构约束
不得依赖 Game、AIController、Planner、Domain transitions 或其它 adapter；不得重新解释 ally/enemy 转移方向。
*/
import { isTransferDirectionAllowed } from "../../ai/policy/TransferPolicy.js?build=20260816-fr-arch-14-runtime-closure";

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
isTransferDirectionAllowed。

边界与不变量
真人路径恒允许；AI 己方→敌方由 TransferPolicy 公式拒绝；Adapter 不重新解释方向。
*/
export function isTransferExecutionAllowed(source, from, receiver) {
  if (source?.controllerType !== "ai") return true;
  return isTransferDirectionAllowed(source, from, receiver);
}
