/*
模块职责
在 GameState 边界组合唯一 Fact、唯一 Probability 与 World。

上游
AiController、ResponseBoundary、测试与搜索调用方。

下游
Fact/Probability/World 工厂与 Domain Team/Skill Rules。

状态边界
只读当前 GameState，输出互不持有 Game 引用的不可变根快照。

信息边界
敌方未知牌只能经 Fact 的合法记忆与 Probability 的当前有限池查询进入 World。

架构约束
createInitialWorld 只做 World 正式组合入口，不得另存一份投影或概率逻辑。
*/
import { ACTIVE_SKILL_DEFINITIONS } from "../../domain/definitions/skills/SkillDefinitions.js";
import { getSkillCost } from "../../domain/rules/skill/SkillRules.js";
import {
  getAttackLimitFromRules,
  getTeamRules,
  getTurnEnergyBreakdownFromRules
} from "../../domain/rules/team/TeamRules.js";
import { createFact } from "./Fact.js";
import { createProbabilityState } from "./Probability.js";
import { createWorld } from "./World.js";

/*
功能
集中计算 World 所需但尚由 GameState 权威提供的规则派生字段。

调用方
createStateContracts。

输入
当前 GameState。

输出
按玩家 ID 索引的领域与规则派生值表。

读取状态
Player 回合标记、装备、角色技能与 Domain Team/Skill Rules。

写入状态
无。

调用函数
Domain TeamRules、Domain SkillRules.getSkillCost。

边界与不变量
只转换字段承载位置，不重写领域规则；World 仅接收结果而不自行计算。
*/
function createDerivedPlayersById(state) {
  return Object.fromEntries(state.players.map((player) => {
    const activeSkillId = player.character.activeSkillIds[0] ?? null;
    const activeSkill = ACTIVE_SKILL_DEFINITIONS[activeSkillId] ?? null;
    const teamRules = getTeamRules({ players:state.players }, player);
    const energyBreakdown = getTurnEnergyBreakdownFromRules(
      teamRules,
      player.equipment?.definitionId ?? null
    );
    const energyDeviceBreakdown = getTurnEnergyBreakdownFromRules(teamRules, "energyDevice");
    return [player.id, Object.freeze({
      turnEnergyGainWithoutEquipment:energyBreakdown.baseAmount + energyBreakdown.teamBonus,
      energyDeviceTurnEnergyGain:energyDeviceBreakdown.equipmentBonus,
      nextTurnBaseAttackLimit:getAttackLimitFromRules(teamRules),
      guardianAidUsed:Boolean(player.turnFlags.guardianAidUsed),
      spyGapTriggered:Boolean(player.turnFlags.spyGapTriggered),
      activeSkillCost:getSkillCost(activeSkill, player, state.players)
    })];
  }));
}

/*
功能
从一次合法 GameState 读取组合完整的 AI 状态契约集合。

调用方
createInitialWorld、状态契约测试与 AIController。

输入
观察者玩家 ID、当前 GameState 与可选合法剩余牌计数。

输出
冻结的 fact、probabilityState、world 集合；观察者缺失时抛错。

读取状态
GameState、观察者合法 aiMemory 与领域规则。

写入状态
无。

调用函数
createFact、createProbabilityState、createWorld、createDerivedPlayersById。

边界与不变量
Fact 不含概率，Probability 不含历史 identity，最终 World 不保留 Game 或 Player 引用。
*/
export function createStateContracts(viewerId, state, currentCardCounts = null) {
  const fact = createFact(viewerId, state, currentCardCounts);
  const probabilityState = createProbabilityState(fact);
  const derivedPlayersById = createDerivedPlayersById(state);
  const world = createWorld(fact, probabilityState, derivedPlayersById);
  return Object.freeze({ fact, probabilityState, world });
}

/*
功能
返回 Planner、Generator 与 Simulator 直接消费的 canonical World。

调用方
AiController、ResponseBoundary、现有测试与AI 模块。

输入
观察者玩家 ID、当前 GameState 与可选合法剩余牌计数。

输出
createStateContracts 组合出的 World。

读取状态
由 createStateContracts 统一读取。

写入状态
无。

调用函数
createStateContracts。

边界与不变量
本正式组合入口不得复制 Fact、Probability 或 Search 逻辑。
*/
export function createInitialWorld(viewerId, state, currentCardCounts = null) {
  return createStateContracts(viewerId, state, currentCardCounts).world;
}
