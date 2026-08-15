/*
模块职责
拥有观察者合法私有记忆的快照，并提供 Knowledge API 的单一实现。

上游
AIController、状态组合入口与状态契约测试。

下游
BeliefState 的剩余牌计数、概率与隐藏世界采样纯函数。

状态边界
读取观察者 aiMemory；本服务只为失效操作写入该观察者记忆。

信息边界
只允许观察者合法记录的实体牌记忆，禁止用真实敌方手牌补全未知位置。

架构约束
不得拥有概率公式或搜索状态转换；概率查询必须委托给 BeliefState 权威实现。
*/
import { TOTAL_CARD_COUNT } from "../../config/cardConfig.js?build=20260815-residual-end-threat-fix";
import {
  deriveRemainingCardCounts,
  probabilityFromRemainingCounts,
  sampleHiddenWorlds
} from "./BeliefState.js?build=20260815-residual-end-threat-fix";

/*
功能
把观察者对指定玩家的合法实体牌记忆投影为不可变列表。

调用方
createKnowledgeState。

输入
观察者 Player 与被观察玩家 ID。

输出
冻结的 cardId、definitionId 记录数组。

读取状态
观察者 aiMemory.knownCardsByPlayer。

写入状态
无。

调用函数
无。

边界与不变量
只复制现有合法记忆，不检查或读取目标真实手牌。
*/
function projectKnownCards(viewer, ownerId) {
  const records = viewer.aiMemory.knownCardsByPlayer[ownerId] ?? {};
  return Object.freeze(Object.entries(records).map(([cardId, definitionId]) => Object.freeze({
    cardId,
    definitionId
  })));
}

/*
功能
创建观察者当前合法私有记忆的不可变 Knowledge 快照。

调用方
createStateContracts、状态契约测试。

输入
观察者 Player 与只含合法玩家身份的 VisibleState。

输出
冻结的 viewerId 与逐玩家已知牌记录。

读取状态
观察者 aiMemory、VisibleState 玩家 ID。

写入状态
无。

调用函数
projectKnownCards。

边界与不变量
Knowledge 不推断未知牌，也不保留 aiMemory 的可变引用。
*/
export function createKnowledgeState(viewer, visibleState) {
  const knownCardsByPlayer = Object.fromEntries(visibleState.players.map((player) => [
    player.id,
    player.id === viewer.id ? Object.freeze([]) : projectKnownCards(viewer, player.id)
  ]));
  return Object.freeze({
    viewerId:viewer.id,
    knownCardsByPlayer:Object.freeze(knownCardsByPlayer)
  });
}

export class Knowledge {
  /*
  功能
  创建绑定当前 Game 生命周期的 Knowledge 服务。

  调用方
  AiController 构造流程、Knowledge 单元测试。

  输入
  当前 Game 服务对象。

  输出
  绑定观察者记忆的 Knowledge 实例。

  读取状态
  无。

  写入状态
  实例 game 引用。

  调用函数
  无。

  边界与不变量
  game 只供合法公开区域计数、随机源和记忆失效使用。
  */
  constructor(game) {
    this.game = game;
  }

  /*
  功能
  读取观察者对指定玩家的合法实体牌记忆。

  调用方
  AI 记忆查询与测试。

  输入
  观察者 Player 与持牌者 ID。

  输出
  新的 cardId、definitionId 记录数组。

  读取状态
  观察者 aiMemory.knownCardsByPlayer。

  写入状态
  无。

  调用函数
  projectKnownCards。

  边界与不变量
  不得读取持牌者真实手牌；返回数组与内部记忆相互隔离。
  */
  knownCards(viewer, ownerId) {
    return projectKnownCards(viewer, ownerId).map((entry) => ({ ...entry }));
  }

  /*
  功能
  按观察者合法信息计算当前剩余卡牌实例计数。

  调用方
  AiController、概率查询、隐藏世界采样准备与测试。

  输入
  观察者 Player。

  输出
  新的定义 ID 到剩余实例数对象。

  读取状态
  GameState 合法公开区域、观察者手牌与合法记忆。

  写入状态
  无。

  调用函数
  deriveRemainingCardCounts。

  边界与不变量
  不得读取敌方真实手牌或未来牌堆顺序。
  */
  remainingCounts(viewer) {
    return deriveRemainingCardCounts(viewer, this.game?.state);
  }

  /*
  功能
  查询下一未知牌为指定定义的剩余牌条件概率。

  调用方
  AI 概率查询与测试。

  输入
  观察者 Player 与卡牌定义 ID。

  输出
  零到一之间的概率。

  读取状态
  当前合法剩余牌计数。

  写入状态
  无。

  调用函数
  remainingCounts、probabilityFromRemainingCounts。

  边界与不变量
  未知定义或空剩余牌池返回零。
  */
  probability(viewer, definitionId) {
    return probabilityFromRemainingCounts(this.remainingCounts(viewer), definitionId);
  }

  /*
  功能
  使观察者对已离开目标手牌的实体记忆立即失效。

  调用方
  Game 卡牌区域迁移与记忆维护流程。

  输入
  观察者 Player、原持牌者 ID 与卡牌实体 ID。

  输出
  无。

  读取状态
  观察者 aiMemory。

  写入状态
  删除观察者对应实体记忆，生命周期与卡牌离手同步。

  调用函数
  无。

  边界与不变量
  不存在的记录静默忽略，不得修改其他观察者记忆。
  */
  invalidate(viewer, ownerId, cardId) {
    delete viewer.aiMemory.knownCardsByPlayer[ownerId]?.[cardId];
  }

  /*
  功能
  返回固定牌组的卡牌实例总数。

  调用方
  AI 知识统计与测试。

  输入
  无。

  输出
  配置定义的总卡牌实例数。

  读取状态
  TOTAL_CARD_COUNT。

  写入状态
  无。

  调用函数
  无。

  边界与不变量
  结果不随当前局牌区变化。
  */
  totalCards() {
    return TOTAL_CARD_COUNT;
  }

  /*
  功能
  从 SearchState 的合法 Belief 信息采样隐藏手牌世界。

  调用方
  Planner、隐藏信息测试。

  输入
  观察者 Player、SearchState 与非负样本数。

  输出
  彼此独立的隐藏牌定义世界数组。

  读取状态
  SearchState 剩余计数与玩家知识字段、Game 随机源。

  写入状态
  无。

  调用函数
  BeliefState.sampleHiddenWorlds。

  边界与不变量
  采样函数不得回读 GameState，缺少合法剩余计数时抛错。
  */
  sampleHiddenWorlds(viewer, searchState, count) {
    return sampleHiddenWorlds(viewer, searchState, count, this.game.random);
  }
}
