/*
模块职责
把真实 MatchState 玩家投影为 Domain TeamRules 查询所需的 canonical facts。

上游
composition root、Match/Turn workflows 与 AI execution boundary。

下游
Domain TeamRules 与 RuleStateView。

状态边界
只读显式 getState capability；不写 MatchState。

信息边界
只投影公开阵营与装备定义，不读取隐藏手牌。

架构约束
不得复制阵营补偿数值或持有 composition root。
*/
import {
  getAttackLimitFromRules, getDrawCountFromRules, getEffectiveAttackLimit,
  getInitialHandCountFromRules,
  getMaxEnergyFromRules, getRecoverLimitFromRules, getTeamRules, getTeamSize,
  getTurnEnergyBreakdownFromRules, getTurnEnergyGainFromRules, isSmallTeam
} from "../../domain/rules/team/TeamRules.js";
import { createRuleStateView } from "../../domain/state/queries/RuleStateView.js";

/*
功能
创建真实对局的阵营规则查询集合。

调用方
composition root。

输入
返回当前 MatchState 的函数。

输出
冻结查询对象。

读取状态
每次调用时读取当前 players。

写入状态
无。

调用函数
Domain TeamRules 与 createRuleStateView。

边界与不变量
不缓存玩家或阵营结果；所有规则数值由 Domain authority 返回。
*/
export function createTeamRuleQueries(getState) {
  if (typeof getState !== "function") throw new TypeError("TeamRuleQueries 缺少 getState capability");
  /*
  功能
  取得当前 MatchState 的 canonical team-rule player facts。

  调用方
  本函数返回的所有阵营规则查询。

  输入
  无。

  输出
  仅含 players 投影的 rule state。

  读取状态
  getState 返回的当前 MatchState。

  写入状态
  无。

  调用函数
  getState、createRuleStateView。

  边界与不变量
  每次查询重新投影，不缓存过期玩家状态。
  */
  const ruleState = () => ({ players:createRuleStateView(getState()).players() });
  /*
  功能
把 Player entity 归一化为 TeamRules 所需公开阵营、装备与当前非装备突袭上限事实。

  调用方
  rulesFor、回合能量查询。

  输入
  Player entity、teamId 字符串或空值。

  输出
  原字符串/空值，或 battleTeam 与 equipmentDefinitionId 投影。

  读取状态
  player.battleTeam、当前装备定义 ID 与 turnFlags.attackLimit。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  不暴露手牌或 mutable equipment entity；attackLimit 仍不包含装备加成。
  */
  const playerFact = (player) => !player || typeof player === "string" ? player : ({
    battleTeam:player.battleTeam,
    equipmentDefinitionId:player.equipmentDefinitionId ?? player.equipment?.definitionId ?? null,
    attackLimit:player.turnFlags?.attackLimit ?? player.attackLimit
  });
  /*
  功能
  返回指定玩家或阵营当前适用的 Domain team rules。

  调用方
  getRules 及所有数值查询包装。

  输入
  Player entity、teamId 字符串或空值。

  输出
  Domain getTeamRules 返回的规则对象。

  读取状态
  当前 ruleState 与 playerFact。

  写入状态
  无。

  调用函数
  getTeamRules、ruleState、playerFact。

  边界与不变量
  Application 不解释或缓存 Domain 返回的固定规则数值。
  */
  const rulesFor = (player) => getTeamRules(ruleState(), playerFact(player));
  return Object.freeze({
    getTeamSize:(playerOrTeam) => getTeamSize(ruleState(), playerOrTeam),
    isSmallTeam:(playerOrTeam) => isSmallTeam(ruleState(), playerOrTeam),
    getRules:rulesFor,
    getInitialHandCount:(player) => getInitialHandCountFromRules(rulesFor(player)),
    getDrawCount:(player) => getDrawCountFromRules(rulesFor(player)),
    getAttackLimit:(player) => {
      const fact = playerFact(player);
      return getEffectiveAttackLimit(
        Number.isFinite(Number(fact?.attackLimit))
          ? Number(fact.attackLimit)
          : getAttackLimitFromRules(rulesFor(player)),
        fact?.equipmentDefinitionId ?? null
      );
    },
    getRecoverLimit:(player) => getRecoverLimitFromRules(rulesFor(player)),
    getMaxEnergy:(player) => getMaxEnergyFromRules(rulesFor(player)),
    getTurnEnergyGain:(player) => getTurnEnergyGainFromRules(
      rulesFor(player),
      playerFact(player)?.equipmentDefinitionId ?? null
    ),
    getTurnEnergyBreakdown:(player) => getTurnEnergyBreakdownFromRules(
      rulesFor(player),
      playerFact(player)?.equipmentDefinitionId ?? null
    )
  });
}
