/*
模块职责
唯一拥有阵营与阶段的玩家可见名称；不拥有任何阵营规模、阶段转换或游戏规则。

上游
UI templates、UIManager 与 composition root 的玩家可见日志。

下游
无。

状态边界
纯静态展示元数据，不读取或写入 MatchState。

信息边界
全部字段均为公开文案。

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
