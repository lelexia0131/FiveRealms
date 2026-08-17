/*
模块职责
唯一拥有 FiveRealms 阵营规模补偿与资源额度的纯规则计算；不拥有组队 RNG、UI 标签或 workflow。

上游
TeamRuleQueries、TeamAssignment 的 boundary 与当前 application/match consumer。

下游
RULESET_DEFINITION 与 CARD_DEFINITIONS 。

状态边界
只读 state.players 与玩家 Domain 投影；不写状态。

信息边界
不读取 controllerType、aiMemory、AI、UI 或隐藏信息。

架构约束
不得依赖 application/adapters/Game runtime；不得随机；不得迁移 match setup。
*/
import { RULESET_DEFINITION } from "../../definitions/ruleset/RulesetDefinition.js?build=20260817-architecture-closure-final";
import { CARD_DEFINITIONS } from "../../definitions/cards/CardDefinitions.js?build=20260817-architecture-closure-final";

/*
功能
决定当前存活阵营的胜者或 null。

调用方
Application Match victory workflow 与 tests。

输入
state 投影。

输出
"dawn"、"dusk" 或 null。

读取状态
players.alive 与 battleTeam。

写入状态
无。

调用函数
无。

边界与不变量
只有单一阵营存活才分出胜负；双阵营存活返回 null；不写 phase 或 winnerTeam。
*/
export function getWinningTeam(state) {
  const dawnAlive = state.players.some((player) => player.alive && player.battleTeam === "dawn");
  const duskAlive = state.players.some((player) => player.alive && player.battleTeam === "dusk");
  if (dawnAlive && duskAlive) return null;
  return dawnAlive ? "dawn" : "dusk";
}

/*
功能
返回指定阵营的座位数。


调用方
TeamRules、TeamAssignment 与 tests。

输入
state 与 player 或 team id。

输出
阵营人数。

读取状态
state.players.battleTeam。

写入状态
无。

调用函数
无。

边界与不变量
battleTeam 是唯一阵营事实源。
*/
export function getTeamSize(state, playerOrTeam) {
  const team = typeof playerOrTeam === "string" ? playerOrTeam : playerOrTeam?.battleTeam;
  return state.players.filter((player) => player.battleTeam === team).length;
}

/*
功能
判断玩家是否属于二人小队。

调用方
TeamRules 与 tests。

输入
state 与 player 投影。

输出
布尔值。

读取状态
getTeamSize。

写入状态
无。

调用函数
getTeamSize。

边界与不变量
小队规模来自 RulesetDefinition。
*/
export function isSmallTeam(state, player) {
  return getTeamSize(state, player) === RULESET_DEFINITION.smallTeamSize;
}

/*
功能
返回玩家阵营适用的补偿规则对象。

调用方
TeamRules 与 tests。

输入
state 与 player 投影。

输出
smallTeamBonuses 或 largeTeamRules。

读取状态
isSmallTeam、RULESET_DEFINITION。

写入状态
无。

调用函数
isSmallTeam。

边界与不变量
返回冻结配置引用。
*/
export function getTeamRules(state, player) {
  return isSmallTeam(state, player)
    ? RULESET_DEFINITION.smallTeamBonuses
    : RULESET_DEFINITION.largeTeamRules;
}

/*
功能
从已决定 team rules 返回开局手牌数。

调用方
TeamRuleQueries boundary 与 getInitialHandCount。

输入
teamRules。

输出
整数。

读取状态
RULESET_DEFINITION.initialHandCount。

写入状态
无。

调用函数
无。

边界与不变量
teamRules 未显式覆盖时使用 Ruleset 默认。
*/
export function getInitialHandCountFromRules(teamRules) {
  return teamRules.initialHandCount ?? RULESET_DEFINITION.initialHandCount;
}

/*
功能
从已决定 team rules 返回每回合摸牌数。

调用方
TeamRuleQueries boundary 与 getDrawCount。

输入
teamRules。

输出
整数。

读取状态
RULESET_DEFINITION.defaultDrawCount。

写入状态
无。

调用函数
无。

边界与不变量
teamRules 未显式覆盖时使用 Ruleset 默认。
*/
export function getDrawCountFromRules(teamRules) {
  return teamRules.drawCountPerTurn ?? RULESET_DEFINITION.defaultDrawCount;
}

/*
功能
从已决定 team rules 返回突袭上限。

调用方
TeamRuleQueries boundary 与 getAttackLimit。

输入
teamRules。

输出
整数。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
只读取已决定规则。
*/
export function getAttackLimitFromRules(teamRules) {
  return teamRules.attackLimitPerTurn;
}

/*
功能
从已决定 team rules 返回调息上限。

调用方
TeamRuleQueries boundary 与 getRecoverLimit。

输入
teamRules。

输出
整数或 null。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
null 表示无限。
*/
export function getRecoverLimitFromRules(teamRules) {
  return teamRules.recoverLimitPerTurn;
}

/*
功能
从已决定 team rules 返回能量上限。

调用方
TeamRuleQueries boundary 与 getMaxEnergy。

输入
teamRules。

输出
整数。

读取状态
RULESET_DEFINITION.defaultMaxEnergy。

写入状态
无。

调用函数
无。

边界与不变量
teamRules 未显式覆盖时使用 Ruleset 默认。
*/
export function getMaxEnergyFromRules(teamRules) {
  return teamRules.maxEnergy ?? RULESET_DEFINITION.defaultMaxEnergy;
}

/*
功能
从已决定 team rules 与装备定义返回回合能量分项。

调用方
TeamRuleQueries boundary 与 getTurnEnergyBreakdown。

输入
teamRules 与 equipmentDefinitionId。

输出
{ baseAmount, teamBonus, equipmentBonus }。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
装备回合能量加成只读取 CardDefinitions.turnEnergyBonus；未定义时为 0。
*/
export function getTurnEnergyBreakdownFromRules(teamRules, equipmentDefinitionId) {
  return {
    baseAmount: teamRules.turnEnergyGain,
    teamBonus: teamRules.turnEnergyBonus ?? 0,
    equipmentBonus: CARD_DEFINITIONS[equipmentDefinitionId]?.turnEnergyBonus ?? 0
  };
}

/*
功能
从已决定 team rules 与装备定义返回回合总能量获取。

调用方
TeamRuleQueries boundary 与 getTurnEnergyGain。

输入
teamRules 与 equipmentDefinitionId。

输出
整数。

读取状态
无。

写入状态
无。

调用函数
getTurnEnergyBreakdownFromRules。

边界与不变量
总能量 = 基础 + 阵营 + 装备。
*/
export function getTurnEnergyGainFromRules(teamRules, equipmentDefinitionId) {
  const breakdown = getTurnEnergyBreakdownFromRules(teamRules, equipmentDefinitionId);
  return breakdown.baseAmount + breakdown.teamBonus + breakdown.equipmentBonus;
}

/*
功能
返回玩家开局手牌数。

调用方
TeamRules。

输入
state 与 player 投影。

输出
整数。

读取状态
getTeamRules、RULESET_DEFINITION。

写入状态
无。

调用函数
getTeamRules。

边界与不变量
不读取手牌运行时。
*/
export function getInitialHandCount(state, player) {
  return getInitialHandCountFromRules(getTeamRules(state, player));
}

/*
功能
返回玩家每回合摸牌数。

调用方
TeamRules。

输入
state 与 player 投影。

输出
整数。

读取状态
getTeamRules、RULESET_DEFINITION。

写入状态
无。

调用函数
getTeamRules。

边界与不变量
不读取牌堆。
*/
export function getDrawCount(state, player) {
  return getDrawCountFromRules(getTeamRules(state, player));
}

/*
功能
返回玩家每回合突袭上限。

调用方
TeamRules。

输入
state 与 player 投影。

输出
整数。

读取状态
getTeamRules。

写入状态
无。

调用函数
getTeamRules。

边界与不变量
不读取当前使用次数。
*/
export function getAttackLimit(state, player) {
  return getAttackLimitFromRules(getTeamRules(state, player));
}

/*
功能
返回玩家每回合调息上限。

调用方
TeamRules。

输入
state 与 player 投影。

输出
整数或 null。

读取状态
getTeamRules。

写入状态
无。

调用函数
getTeamRules。

边界与不变量
null 表示无限。
*/
export function getRecoverLimit(state, player) {
  return getRecoverLimitFromRules(getTeamRules(state, player));
}

/*
功能
返回玩家能量上限。

调用方
TeamRules。

输入
state 与 player 投影。

输出
整数。

读取状态
getTeamRules、RULESET_DEFINITION。

写入状态
无。

调用函数
getTeamRules。

边界与不变量
不读取当前能量。
*/
export function getMaxEnergy(state, player) {
  return getMaxEnergyFromRules(getTeamRules(state, player));
}

/*
功能
返回玩家回合能量获取分项。

调用方
TeamRules。

输入
state 与 player 投影。

输出
baseAmount/teamBonus/equipmentBonus。

读取状态
getTeamRules 与 player.equipmentDefinitionId。

写入状态
无。

调用函数
getTeamRules。

边界与不变量
装备回合能量固定加成由 CardDefinitions 拥有，本函数只委托规则组合。
*/
export function getTurnEnergyBreakdown(state, player) {
  return getTurnEnergyBreakdownFromRules(
    getTeamRules(state, player),
    player.equipmentDefinitionId
  );
}

/*
功能
返回玩家回合总能量获取。

调用方
TeamRuleQueries boundary 与 tests。

输入
state 与 player 投影。

输出
整数。

读取状态
getTurnEnergyGainFromRules。

写入状态
无。

调用函数
getTeamRules、getTurnEnergyGainFromRules。

边界与不变量
总能量 = 基础 + 阵营 + 装备。
*/
export function getTurnEnergyGain(state, player) {
  return getTurnEnergyGainFromRules(
    getTeamRules(state, player),
    player.equipmentDefinitionId
  );
}
