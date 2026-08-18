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
  getAttackLimitFromRules, getDrawCountFromRules, getInitialHandCountFromRules,
  getMaxEnergyFromRules, getRecoverLimitFromRules, getTeamRules, getTeamSize,
  getTurnEnergyBreakdownFromRules, getTurnEnergyGainFromRules, isSmallTeam
} from "../../domain/rules/team/TeamRules.js?build=20260818-skill-rules-locality-refactor";
import { createRuleStateView } from "../../domain/state/queries/RuleStateView.js?build=20260818-skill-rules-locality-refactor";

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
  执行 ruleState 对应的 TeamRuleQueries 职责。

  调用方
  本模块内部流程及显式公开边界。

  输入
  函数签名声明的参数。

  输出
  函数实现声明的返回值。

  读取状态
  仅函数体显式读取的参数、模块或实例状态。

  写入状态
  仅执行函数体显式声明的写入；查询路径不写状态。

  调用函数
  仅调用函数体中显式列出的依赖。

  边界与不变量
  遵守模块头定义的 ownership、状态与信息边界。
  */
  const ruleState = () => ({ players:createRuleStateView(getState()).players() });
  /*
  功能
  执行 playerFact 对应的 TeamRuleQueries 职责。

  调用方
  本模块内部流程及显式公开边界。

  输入
  函数签名声明的参数。

  输出
  函数实现声明的返回值。

  读取状态
  仅函数体显式读取的参数、模块或实例状态。

  写入状态
  仅执行函数体显式声明的写入；查询路径不写状态。

  调用函数
  仅调用函数体中显式列出的依赖。

  边界与不变量
  遵守模块头定义的 ownership、状态与信息边界。
  */
  const playerFact = (player) => !player || typeof player === "string" ? player : ({
    battleTeam:player.battleTeam,
    equipmentDefinitionId:player.equipmentDefinitionId ?? player.equipment?.definitionId ?? null
  });
  /*
  功能
  执行 rulesFor 对应的 TeamRuleQueries 职责。

  调用方
  本模块内部流程及显式公开边界。

  输入
  函数签名声明的参数。

  输出
  函数实现声明的返回值。

  读取状态
  仅函数体显式读取的参数、模块或实例状态。

  写入状态
  仅执行函数体显式声明的写入；查询路径不写状态。

  调用函数
  仅调用函数体中显式列出的依赖。

  边界与不变量
  遵守模块头定义的 ownership、状态与信息边界。
  */
  const rulesFor = (player) => getTeamRules(ruleState(), playerFact(player));
  return Object.freeze({
    getTeamSize:(playerOrTeam) => getTeamSize(ruleState(), playerOrTeam),
    isSmallTeam:(playerOrTeam) => isSmallTeam(ruleState(), playerOrTeam),
    getRules:rulesFor,
    getInitialHandCount:(player) => getInitialHandCountFromRules(rulesFor(player)),
    getDrawCount:(player) => getDrawCountFromRules(rulesFor(player)),
    getAttackLimit:(player) => getAttackLimitFromRules(rulesFor(player)),
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
