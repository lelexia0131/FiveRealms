/*
模块职责
在 GameState 边界组合 Visible、Knowledge、Belief 与 Search 四类正式状态契约。

上游
AiController、ResponseBoundary、测试与搜索调用方。

下游
四类 state 工厂、TeamRuleService、技能成本和卡牌价值权威。

状态边界
只读当前 GameState，输出互不持有 Game 引用的不可变根快照。

信息边界
敌方未知牌只能经 Knowledge 合法记忆和 Belief 概率进入 SearchState。

架构约束
createInitialSearchState 只做 SearchState 正式组合入口，不得另存一份投影或概率逻辑。
*/
import { CARD_DEFINITIONS } from "../../config/cardConfig.js?build=20260815-residual-end-threat-fix";
import { TeamRuleService } from "../../core/TeamRuleService.js?build=20260815-residual-end-threat-fix";
import { ACTIVE_SKILLS, getActiveSkillCost } from "../../generals/skillRegistry.js?build=20260815-residual-end-threat-fix";
import { getBaseCardAiValue, getRoleCardAiValue } from "../value/CardValue.js?build=20260815-residual-end-threat-fix";
import { createBeliefState } from "./BeliefState.js?build=20260815-residual-end-threat-fix";
import { createKnowledgeState } from "./Knowledge.js?build=20260815-residual-end-threat-fix";
import { createSearchState } from "./SearchState.js?build=20260815-residual-end-threat-fix";
import { createVisibleState } from "./VisibleState.js?build=20260815-residual-end-threat-fix";

/*
功能
计算指定装备对角色专属牌值相对基础牌值的初始差量。

调用方
createDerivedPlayersById。

输入
玩家公开角色 ID 与装备定义 ID。

输出
角色牌值减基础牌值的数值差；缺少身份或装备时为零。

读取状态
角色牌值配置、基础牌值配置。

写入状态
无。

调用函数
getRoleCardAiValue、getBaseCardAiValue。

边界与不变量
这里只注入既有 Value 结果，不改变价值规则或重复记账。
*/
function equipmentRoleDelta(player, definitionId) {
  if (!player?.generalId || !definitionId) return 0;
  return getRoleCardAiValue(player.generalId, definitionId) - getBaseCardAiValue(definitionId);
}

/*
功能
集中计算 SearchState 所需但尚由 GameState 权威提供的派生字段。

调用方
createStateContracts。

输入
当前 GameState 与已绑定该状态的 TeamRuleService。

输出
按玩家 ID 索引的领域、规则和初始价值派生值表。

读取状态
Player 回合标记、装备、角色技能与 TeamRuleService 规则。

写入状态
无。

调用函数
TeamRuleService 能量与攻击规则、getActiveSkillCost、equipmentRoleDelta。

边界与不变量
只转换字段承载位置，不重写领域规则；SearchState 仅接收结果而不自行计算。
*/
function createDerivedPlayersById(state, teamRules) {
  return Object.fromEntries(state.players.map((player) => {
    const activeSkillId = player.general.activeSkillIds[0] ?? null;
    const activeSkill = ACTIVE_SKILLS[activeSkillId] ?? null;
    const energyBreakdown = teamRules.getTurnEnergyBreakdown(player);
    const energyDeviceBreakdown = teamRules.getTurnEnergyBreakdown({
      ...player,
      equipment:{ definitionId:"energyDevice" }
    });
    const equipmentDefinitionId = player.equipment?.definitionId ?? null;
    return [player.id, Object.freeze({
      turnEnergyGainWithoutEquipment:energyBreakdown.baseAmount + energyBreakdown.teamBonus,
      energyDeviceTurnEnergyGain:energyDeviceBreakdown.equipmentBonus,
      nextTurnBaseAttackLimit:teamRules.getAttackLimit(player),
      guardianAidUsed:Boolean(player.turnFlags.guardianAidUsed),
      spyGapTriggered:Boolean(player.turnFlags.spyGapTriggered),
      activeSkillCost:getActiveSkillCost(state, player, activeSkill),
      initialEquipmentValue:equipmentDefinitionId
        ? (CARD_DEFINITIONS[equipmentDefinitionId]?.aiValue ?? 7)
        : 0,
      initialEquipmentRoleDelta:equipmentDefinitionId
        ? equipmentRoleDelta(player, equipmentDefinitionId)
        : 0
    })];
  }));
}

/*
功能
从一次合法 GameState 读取组合完整的 AI 状态契约集合。

调用方
createInitialSearchState、状态契约测试与 AIController。

输入
观察者玩家 ID、当前 GameState 与可选合法剩余牌计数。

输出
冻结的 visibleState、knowledgeState、beliefState、searchState 集合；观察者缺失时抛错。

读取状态
GameState、观察者合法 aiMemory、领域规则与既有价值配置。

写入状态
无。

调用函数
四类状态工厂、createDerivedPlayersById。

边界与不变量
每层只拥有归属字段，最终 SearchState 不保留 Game 或 Player 引用。
*/
export function createStateContracts(viewerId, state, remainingCardCounts = null) {
  const viewer = state.players.find((player) => player.id === viewerId);
  if (!viewer) throw new Error("AI 可见状态缺少观察者");
  const visibleState = createVisibleState(viewerId, state);
  const knowledgeState = createKnowledgeState(viewer, visibleState);
  const beliefState = createBeliefState(viewerId, visibleState, knowledgeState, remainingCardCounts);
  const teamRules = new TeamRuleService({ state });
  const derivedPlayersById = createDerivedPlayersById(state, teamRules);
  const searchState = createSearchState(
    visibleState,
    knowledgeState,
    beliefState,
    derivedPlayersById
  );
  return Object.freeze({ visibleState, knowledgeState, beliefState, searchState });
}

/*
功能
返回 Planner 与 Simulator 直接消费的扁平 SearchState。

调用方
AiController、ResponseBoundary、现有测试与AI 模块。

输入
观察者玩家 ID、当前 GameState 与可选合法剩余牌计数。

输出
createStateContracts 组合出的 SearchState。

读取状态
由 createStateContracts 统一读取。

写入状态
无。

调用函数
createStateContracts。

边界与不变量
本正式组合入口不得复制投影、Knowledge、Belief 或 Search 逻辑。
*/
export function createInitialSearchState(viewerId, state, remainingCardCounts = null) {
  return createStateContracts(viewerId, state, remainingCardCounts).searchState;
}
