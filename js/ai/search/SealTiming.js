/*
模块职责
拥有 Planner 同层候选中封印动作的搜索时序折扣。

上游
Planner：同层候选完整物化后请求封印时机项；直接测试验证相同边界。

下游
无。

状态边界
只处理已物化候选的数值，不读取或修改搜索状态。

信息边界
不读取卡牌、玩家、隐藏信息或领域判定概率。

架构约束
只表达搜索排序时机，不得承担封印规则、领域概率或最终状态价值。
*/

const SEAL_EARLY_USE_CAP = 3;

/*
功能
把最佳非封印即时动作的 base transition 按真实 depth 折算为延迟成本。

调用方
Planner 与正式边界。

输入
同层替代动作分数与当前搜索深度。

输出
把动作从 depth d 延迟到 d+1 的价值损失。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
沿用 S/(d+1) 的既有公式，不混入领域状态或最终价值。
*/
export function sealDelayCost(alternativeTransitionScore, depth) {
  return Number(alternativeTransitionScore) / (Number(depth) + 1);
}

/*
功能
把封印延迟成本转换为有界的搜索软性后置惩罚。

调用方
Planner 与正式边界。

输入
延迟成本。

输出
零到既有上限之间的惩罚。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
非正或非法成本返回零；既有上限三保持不变。
*/
export function sealEarlyUsePenalty(delayCost) {
  const cost = Number(delayCost);
  if (!Number.isFinite(cost) || cost <= 0) return 0;
  return Math.min(SEAL_EARLY_USE_CAP, cost);
}
