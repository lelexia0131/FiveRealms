/**
 * AI 回归测试公共辅助：构造合法测试局面并驱动生产 AI。
 *
 * 原则：
 * - 局面构造只使用生产 Player / characterConfig / cardConfig / Game 权威定义；
 * - 不重新实现任何规则；
 * - 其他玩家的手牌仅作为"计数"参与 AI 决策，AI 可见信息由 AiVisibleState /
 *   Knowledge 过滤，本文件不写入任何作弊信息。
 */
import { createGameApplication } from "../js/composition/createGameApplication.js";
import { Player } from "../js/application/match/Player.js";
import { CHARACTER_BY_ID } from "../js/domain/definitions/characters/CharacterDefinitions.js";
import { CARD_DEFINITIONS } from "../js/domain/definitions/cards/CardDefinitions.js";
import { createId } from "../js/utils/helpers.js";
import { deriveCurrentCardCounts } from "../js/ai/Event/Fact.js";

let cardSerial = 0;

/** 可复现随机源（LCG），与 balance.mjs 同型。 */
const TEST_VERSION_STATE = { stateVersion: 0 };

export function makeRandom(seedValue) {
  let seed = (Number(seedValue) || 0) >>> 0;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

/** 创建生产格式卡牌实例：定义属性 + 唯一 id。 */
export function makeCard(definitionId, id = null) {
  const definition = CARD_DEFINITIONS[definitionId];
  if (!definition) throw new Error(`未知卡牌定义：${definitionId}`);
  cardSerial += 1;
  return { ...definition, id: id ?? `bm-card-${cardSerial}` };
}

/** 创建无头 UI，覆盖 Game 在 AI 模拟中可能调用的全部展示接口。 */
export function createHeadlessUi() {
  return {
    createGameSession() { return null; },
    isSessionCurrent() { return true; },
    render() { },
    appendLog() { },
    cancelPendingInteractions() { },
    async requestResponse() { return false; },
    async requestDiscard(player, count) { return player.hand.slice(0, count); },
    async requestPublicCard(_player, cards) { return cards[0] ?? null; },
    async requestHiddenCards(_view, _maximum, _reason) { return []; },
    setCurrentCard() { },
    setPrompt() { },
    setThinking() { },
    showGameOver() { },
    queueFeedback() { },
    showDying() { },
    hideDying() { },
    showPublicPool() { },
    hidePublicPool() { },
    showJudgment() { },
    showDuel() { },
    hideDuel() { },
    showPrivateReveal() { },
    setFastMode() { },
    playSound() { }
  };
}

/**
 * 构造一个可被生产 ActionLegality / AI 直接查询的 Game 局面。
 *
 * @param {Object} options
 * @param {Array<Object>} options.players 玩家配置：
 *   { id, team, character, hp?, energy?, shield?, maxEnergy?,
 *     hand?, equipment?, statuses?, turnFlags?, roundFlags?,
 *     aiMemory? }  aiMemory: { knownCardsByPlayer: { [ownerId]: [{ id, definitionId }] } }
 * @param {Object} options.options
 * @param {string} [options.options.actorId] 当前行动者（默认 players[0].id）
 * @param {number} [options.options.round] 当前轮次
 * @param {number} [options.options.nodeBudget] AI 搜索节点预算
 * @param {number} [options.options.seed] 随机种子
 */
export function makeGame({ players, options = {} }, runtimeOptions = {}) {
  const seed = runtimeOptions.seed ?? options.seed ?? 0x5eed;
  const game = createGameApplication(createHeadlessUi(), makeRandom(seed), { aiSearchSeed: seed });
  game.simulationMode = true;
  game.animationFastMode = true;
  game.aiRandomnessRange = 0;
  const nodeBudget = runtimeOptions.nodeBudget ?? options.nodeBudget ?? null;
  if (nodeBudget) game.aiSearchNodeBudgetOverride = nodeBudget;

  const builtPlayers = players.map((config, index) => {
    const player = new Player({
      id: config.id ?? `p${index}`,
      seatIndex: config.seatIndex ?? index,
      battleTeam: config.team,
      controllerType: "ai"
    });
    const character = CHARACTER_BY_ID[config.character];
    if (!character) throw new Error(`未知角色：${config.character}`);
    player.applyCharacter(TEST_VERSION_STATE, character);
    player.hp = config.hp ?? character.maxHp;
    player.shield = config.shield ?? 0;
    player.energy = config.energy ?? character.initialEnergy;
    player.attackRange = config.attackRange ?? 1;
    player.hand = config.hand ? [...config.hand] : [];
    player.equipment = config.equipment ?? null;
    player.alive = config.alive ?? true;
    player.resetTurnFlags(TEST_VERSION_STATE, game.teamRules.getRules(player));
    player.resetRoundFlags(TEST_VERSION_STATE);
    if (config.turnFlags) Object.assign(player.turnFlags, config.turnFlags);
    if (config.roundFlags) Object.assign(player.roundFlags, config.roundFlags);
    if (config.statuses) {
      for (const [statusId, value] of Object.entries(config.statuses)) {
        if (value === true) player.statuses[statusId] = { stacks: 1 };
        else player.statuses[statusId] = value ?? { stacks: 1 };
      }
    }
    if (config.aiMemory?.knownCardsByPlayer) {
      for (const [ownerId, knownCards] of Object.entries(config.aiMemory.knownCardsByPlayer)) {
        const bucket = player.aiMemory.knownCardsByPlayer[ownerId] ??= {};
        for (const known of knownCards ?? []) {
          bucket[known.id ?? createId("known")] = known.definitionId;
        }
      }
    }
    return player;
  });
  // 先填充 state.players，再按生产 TeamRuleService 计算 maxEnergy，
  // 避免 teamRules 在空 players 上错误回退为默认值。
  game.state.players = builtPlayers;
  for (let index = 0; index < builtPlayers.length; index += 1) {
    const player = builtPlayers[index];
    const config = players[index];
    player.maxEnergy = config.maxEnergy ?? game.teamRules.getMaxEnergy(player);
  }

  game.state.currentPlayerIndex = options.actorId
    ? game.state.players.findIndex((player) => player.id === options.actorId)
    : 0;
  if (game.state.currentPlayerIndex < 0) throw new Error(`未找到行动者：${options.actorId}`);
  game.state.currentRound = options.round ?? 1;
  game.state.phase = "play";
  game.state.deck.cards = [];
  game.state.deck.discardPile = [];
  game.state.deck.resolvingCards = [];
  game.state.deck.judgmentZone = [];

  game.passiveTriggerRegistry.registerForPlayers(game.state.players);
  return game;
}

/** 查询指定玩家全部合法动作（生产 ActionGenerator）。 */
export function getActionCandidates(game, playerId) {
  const player = game.state.players.find((entry) => entry.id === playerId);
  if (!player) return [];
  return game.aiController.getActionCandidates(player);
}

/**
 * 让生产 AI 对当前行动者做一次决策。
 * 返回 { action, legalActions, stats, remainingCardCounts, visibleState }。
 */
export async function runAiDecision(game, playerId = null) {
  const player = game.state.players.find((entry) => entry.id === (playerId ?? game.state.players[game.state.currentPlayerIndex]?.id));
  if (!player) throw new Error("AI 决策失败：找不到行动者");
  const legalActions = getActionCandidates(game, player.id);
  const remainingCardCounts = deriveCurrentCardCounts(player, game.state);
  const action = await game.aiController.selectAction(player, { gameId: game.state.gameId });
  const stats = { ...(game.aiController.lastSearchStats ?? {}) };
  return { action, legalActions, stats, remainingCardCounts, player };
}

/** 动作描述：投影 canonical Action 的稳定场景字段。 */
export function describeAction(action) {
  if (!action) return null;
  return {
    type: action.type,
    cardId: action.cardId ?? action.skillId ?? null,
    cardInstanceId: action.cardInstanceId ?? null,
    targetId: action.targetIds?.[0] ?? null,
    targetIds: [...(action.targetIds ?? [])],
    selection: action.selection ? { ...action.selection } : null
  };
}

/** 在场景运行结束后清理 Game（终止延时与监听器）。 */
export function disposeGame(game) {
  if (game && !game.state.isDisposed) game.dispose();
}

