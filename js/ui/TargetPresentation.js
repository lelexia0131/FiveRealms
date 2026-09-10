/*
功能
用已计算的公开距离呈现当前目标阶段的距离提示。

调用方
UIManager.getDistanceState、NetworkHostBridge。

输入
公开来源、目标、展示卡牌、距离与来源射程。

输出
正式目标距离提示文本。

读取状态
双方阵营、目标存活与展示卡牌定义。

写入状态
无。

调用函数
无。

边界与不变量
距离和射程只能由 authority 提供；本函数不计算距离或目标合法性。
*/
export function presentTargetDistance(source, target, card, distance, range) {
  if (!target.alive) return "已阵亡";
  if (target.battleTeam === source.battleTeam) return `距离 ${distance}`;
  if (card?.definitionId === "assault") return distance <= range ? `距离 ${distance} · 可突袭` : `距离 ${distance} · 超出攻击范围`;
  return `距离 ${distance}`;
}
