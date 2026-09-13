/*
模块职责
唯一拥有阵营与阶段展示名称、经验徽章区间及展示数值校验；不拥有经验奖励或游戏规则。

上游
UI templates、UIManager、历史档案与 NetworkSession 的公开展示字段。

下游
无。

状态边界
纯静态展示元数据，不读取或写入 MatchState。

信息边界
仅公开展示字段；徽章等级名称只作内部元数据，不渲染为可见文案。

架构约束
不得承载 Ruleset 数值、AI 策略或业务结算。
*/

export const TEAM_PRESENTATION = Object.freeze({
  dawn: Object.freeze({ id: "dawn", name: "晨星阵营", shortName: "晨星" }),
  dusk: Object.freeze({ id: "dusk", name: "暮影阵营", shortName: "暮影" })
});

export const PHASE_PRESENTATION = Object.freeze({
  idle: "等待",
  turnStart: "回合开始",
  status: "状态处理",
  energy: "获得能量",
  draw: "摸牌",
  play: "出牌",
  dying: "濒死救援",
  judgment: "判定",
  discard: "弃牌",
  turnEnd: "回合结束",
  gameOver: "对局结束"
});

const BADGE_TIERS = Object.freeze([
  ["bronze", "青铜", 0, 100], ["silver", "白银", 100, 500],
  ["gold", "黄金", 500, 1000], ["diamond", "钻石", 1000, 2000],
  ["epic", "史诗", 2000, 5000], ["king", "王者", 5000, 10000],
  ["legend", "传奇", 10000, null]
].map(([id, name, lowerBound, upperBound]) => Object.freeze({ id, name, lowerBound, upperBound })));

/*
功能
规范化持久化与网络展示的累计经验。

调用方
HistoryStatsManager、NetworkSession、徽章模板。

输入
非负整数经验候选值。

输出
合法经验或默认零。

读取状态
无。

写入状态
无。

调用函数
Number.isSafeInteger。

边界与不变量
缺失、负数及非法数值不传播到展示或累计。
*/
export function normalizeExperience(exp) {
  return Number.isSafeInteger(exp) && exp >= 0 ? exp : 0;
}

/*
功能
提供唯一的经验半开区间徽章等级映射。

调用方
徽章与经验进度模板。

输入
累计经验。

输出
冻结的等级 ID、名称与上下界；传奇无上界。

读取状态
BADGE_TIERS。

写入状态
无。

调用函数
normalizeExperience。

边界与不变量
下界属于新等级，不持久化派生等级名称。
*/
export function getBadgeTierFromExperience(exp) {
  const value = normalizeExperience(exp);
  return BADGE_TIERS.find((tier) => tier.upperBound === null || value < tier.upperBound);
}
