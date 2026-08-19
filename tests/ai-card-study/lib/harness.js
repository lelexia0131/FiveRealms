import { createGameApplication } from "../../../js/composition/createGameApplication.js";
import { Player } from "../../../js/application/match/Player.js";
import { Deck } from "../../../js/application/match/Deck.js";
import { CARD_DEFINITIONS } from "../../../js/domain/definitions/cards/CardDefinitions.js";
import { CHARACTER_DEFINITIONS } from "../../../js/domain/definitions/characters/CharacterDefinitions.js";
import { ActionLegality } from "../../../js/application/action/ActionLegality.js";
import { inAttackRange } from "../../../js/ai/state/DistanceProbabilityBranches.js";
import { createInitialSearchState } from "../../../js/ai/state/StateContracts.js";
import { TrackedRng } from "./rng.js";
import { createHeadlessUi } from "./ui.js";

const TEST_VERSION_STATE = { stateVersion: 0 };

export const DEFAULT_SEED_BASE = 0x9e3779b9;
export const GOLDEN_RATIO_32 = 2654435761;
export const DEFAULT_NODE_BUDGET = 1000;
export const DEFAULT_MAX_ROUNDS = 250;

let syntheticCardSerial = 0;

/** recovery/split runner 专用：把 extra-card serial 恢复到与原 composite job 相同的位置。 */
export function setSyntheticCardSerial(value) {
  syntheticCardSerial = Number(value) >>> 0;
}

/** 生成一张不进入牌堆/弃牌的“额外”实体牌，用于持有价值实验。 */
export function makeExtraCard(definitionId, gameId = "study") {
  syntheticCardSerial += 1;
  return {
    ...CARD_DEFINITIONS[definitionId],
    id: `extra:${gameId}:${syntheticCardSerial}`
  };
}

/**
 * 创建一个已确认角色、已发初始手牌但未启动游戏循环的 Game。
 * roleOverride 为 null 时使用自然候选（player 0 取候选第一）；
 * 否则把该角色强制放入候选首位，使 player 0 成为该角色。
 */
export function createGame({
  seed = 1,
  roleOverride = null,
  nodeBudget = DEFAULT_NODE_BUDGET,
  startIndex = 0
} = {}) {
  const gameSeed = (Number(seed) >>> 0);
  const rng = new TrackedRng(gameSeed);
  const ui = createHeadlessUi();
  const game = createGameApplication(ui, () => rng.next());
  game.simulationMode = true;
  game.animationFastMode = true;
  game.cleanupManager.delay = async () => !game.state.isDisposed;
  game.aiSearchNodeBudgetOverride = nodeBudget;
  game.runGameLoop = async () => {};

  const candidates = game.startSelection("random");
  if (roleOverride) {
    const forced = CHARACTER_DEFINITIONS.find((character) => character.id === roleOverride);
    if (!forced) throw new Error(`未知角色：${roleOverride}`);
    if (!candidates.some((character) => character.id === roleOverride)) {
      candidates[0] = forced;
    }
  }
  game.state.players[0].controllerType = "ai";
  const selectedId = roleOverride ?? candidates[0].id;
  return { game, rng, selectedId, ui, seed: gameSeed, startIndex };
}

/** 调用 confirmCharacter（不启动自动循环），返回已初始化的对局。 */
export async function initGame({ seed = 1, roleOverride = null, nodeBudget = DEFAULT_NODE_BUDGET } = {}) {
  const handle = createGame({ seed, roleOverride, nodeBudget });
  await handle.game.confirmCharacter(handle.selectedId);
  return handle;
}

function cloneSet(source) {
  return new Set(source);
}

function clonePlain(source) {
  if (source === null || typeof source !== "object") return source;
  if (Array.isArray(source)) return source.map((entry) => clonePlain(entry));
  if (source instanceof Set) return new Set([...source].map((entry) => clonePlain(entry)));
  if (source instanceof Map) return new Map([...source].map(([key, value]) => [clonePlain(key), clonePlain(value)]));
  const result = {};
  for (const key of Object.keys(source)) result[key] = clonePlain(source[key]);
  return result;
}

function clonePlayer(player, cardMap) {
  const cloned = Object.assign(Object.create(Player.prototype), {
    ...player,
    character: player.character,
    hand: player.hand.map((card) => cardMap.get(card) ?? { ...card }),
    equipment: player.equipment ? (cardMap.get(player.equipment) ?? { ...player.equipment }) : null,
    turnFlags: {
      ...player.turnFlags,
      categoriesUsed: cloneSet(player.turnFlags.categoriesUsed ?? new Set()),
      activeSkillsUsed: cloneSet(player.turnFlags.activeSkillsUsed ?? new Set()),
      spyGapPendingTargetIds: cloneSet(player.turnFlags.spyGapPendingTargetIds ?? new Set()),
      trackingTargetIds: cloneSet(player.turnFlags.trackingTargetIds ?? new Set())
    },
    roundFlags: { ...player.roundFlags },
    gameFlags: { ...player.gameFlags },
    statistics: { ...player.statistics },
    statuses: clonePlain(player.statuses),
    aiMemory: clonePlain(player.aiMemory)
  });
  return cloned;
}

/**
 * 深克隆一个 Game 的运行状态到全新 Game 实例。
 * 只在安全分叉点调用（回合边界，或响应窗口方法入口前）。
 * 分支随机源从 rngState 快照继续。
 */
export function cloneGame(game, rngState) {
  const branchRng = TrackedRng.from(rngState);
  const ui = createHeadlessUi();
  const clone = createGameApplication(ui, () => branchRng.next());
  clone.simulationMode = true;
  clone.animationFastMode = true;
  clone.cleanupManager.delay = async () => !clone.state.isDisposed;
  clone.aiSearchNodeBudgetOverride = game.aiSearchNodeBudgetOverride;
  clone.runGameLoop = async () => {};

  const old = game.state;
  const cardMap = new Map();
  const mapCard = (card) => {
    if (!card) return null;
    if (cardMap.has(card)) return cardMap.get(card);
    const copy = { ...card };
    cardMap.set(card, copy);
    return copy;
  };
  const mapCards = (cards) => (cards ?? []).map(mapCard);

  const deck = Object.assign(Object.create(Deck.prototype), {
    random: () => branchRng.next(),
    cards: mapCards(old.deck.cards),
    discardPile: mapCards(old.deck.discardPile),
    resolvingCards: mapCards(old.deck.resolvingCards),
    judgmentZone: mapCards(old.deck.judgmentZone),
    reshuffleCount: old.deck.reshuffleCount
  });

  const players = old.players.map((player) => clonePlayer(player, cardMap));
  const publicPool = mapCards(old.publicCardPool ?? []);

  const state = {
    ...old,
    gameId: old.gameId,
    players,
    deck,
    discardPile: deck.discardPile,
    resolvingCards: deck.resolvingCards,
    judgmentZone: deck.judgmentZone,
    publicCardPool: publicPool,
    pendingAction: null,
    pendingResponses: [],
    activeEffects: [],
    currentJudgment: null,
    dyingContext: null,
    duelContext: null,
    isDisposed: false,
    logs: [],
    debugHistory: []
  };
  clone.state = state;
  clone.publicCardPool.cards = publicPool;
  clone.resolutionOwners = new Map(
    [...game.resolutionOwners].map(([card, resolutionId]) => [mapCard(card), resolutionId])
  );
  clone.leverageResolutionIds = new Set(game.leverageResolutionIds);
  clone.state.resolutionSerial = old.resolutionSerial ?? 0;
  clone.syncDeckAliases();
  clone.registerGlobalRules();
  clone.passiveTriggerRegistry.registerForPlayers(clone.state.players);
  return clone;
}

/** 状态指纹：用于验证克隆一致性，不参与价值计算。 */
export function stateFingerprint(game) {
  const state = game.state;
  return {
    gameId: state.gameId,
    round: state.currentRound,
    currentIndex: state.currentPlayerIndex,
    startIndex: state.startingPlayerIndex,
    phase: state.phase,
    deckIds: state.deck.cards.map((card) => card.id),
    discardIds: state.deck.discardPile.map((card) => card.id),
    resolvingIds: state.deck.resolvingCards.map((card) => card.id),
    judgmentIds: state.deck.judgmentZone.map((card) => card.id),
    publicIds: (state.publicCardPool ?? []).map((card) => card.id),
    players: state.players.map((player) => ({
      id: player.id,
      seat: player.seatIndex,
      characterId: player.characterId,
      team: player.battleTeam,
      hp: player.hp,
      maxHp: player.maxHp,
      shield: player.shield,
      energy: player.energy,
      alive: player.alive,
      hand: player.hand.map((card) => card.id),
      equipment: player.equipment?.id ?? null,
      statuses: clonePlain(player.statuses),
      turnFlags: {
        attackUsed: player.turnFlags.attackUsed,
        attackLimit: player.turnFlags.attackLimit,
        recoverUsed: player.turnFlags.recoverUsed,
        momentum: player.turnFlags.momentum,
        categoriesUsed: [...(player.turnFlags.categoriesUsed ?? [])],
        activeSkillsUsed: [...(player.turnFlags.activeSkillsUsed ?? [])],
        trackingTargetIds: [...(player.turnFlags.trackingTargetIds ?? [])],
        spyGapPendingTargetIds: [...(player.turnFlags.spyGapPendingTargetIds ?? [])]
      },
      aiMemory: clonePlain(player.aiMemory)
    }))
  };
}

export function fingerprintsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 结构化指纹：忽略实体 ID 与 gameId（不同进程重建时 ID 串不同），
 * 只比较规则相关的定义序列与标量状态，用于回放一致性校验。
 */
export function structuralFingerprint(game) {
  const state = game.state;
  const seatById = new Map(state.players.map((player) => [player.id, player.seatIndex]));
  const normalizeIds = (value) => {
    if (typeof value === "string" && seatById.has(value)) return `seat:${seatById.get(value)}`;
    if (Array.isArray(value)) return value.map(normalizeIds);
    if (value && typeof value === "object") {
      const result = {};
      for (const key of Object.keys(value)) result[key] = normalizeIds(value[key]);
      return result;
    }
    return value;
  };
  const normalizeKnown = (aiMemory) => {
    const result = {};
    for (const [ownerId, records] of Object.entries(aiMemory?.knownCardsByPlayer ?? {})) {
      const ownerKey = seatById.has(ownerId) ? `seat:${seatById.get(ownerId)}` : ownerId;
      result[ownerKey] = Object.values(records ?? {}).sort();
    }
    return result;
  };
  const normalizeSeatSet = (values) => [...(values ?? [])]
    .map((value) => (seatById.has(value) ? `seat:${seatById.get(value)}` : value))
    .sort();
  return {
    round: state.currentRound,
    currentIndex: state.currentPlayerIndex,
    startIndex: state.startingPlayerIndex,
    phase: state.phase,
    deck: state.deck.cards.map((card) => card.definitionId),
    discard: state.deck.discardPile.map((card) => card.definitionId),
    resolving: state.deck.resolvingCards.map((card) => card.definitionId),
    judgment: state.deck.judgmentZone.map((card) => card.definitionId),
    publicPool: (state.publicCardPool ?? []).map((card) => card.definitionId),
    players: state.players.map((player) => ({
      seat: player.seatIndex,
      characterId: player.characterId,
      team: player.battleTeam,
      hp: player.hp,
      maxHp: player.maxHp,
      shield: player.shield,
      energy: player.energy,
      alive: player.alive,
      hand: player.hand.map((card) => card.definitionId),
      equipment: player.equipment?.definitionId ?? null,
      statuses: normalizeIds(clonePlain(player.statuses)),
      turnFlags: {
        attackUsed: player.turnFlags.attackUsed,
        attackLimit: player.turnFlags.attackLimit,
        recoverUsed: player.turnFlags.recoverUsed,
        momentum: player.turnFlags.momentum,
        categoriesUsed: [...(player.turnFlags.categoriesUsed ?? [])].sort(),
        activeSkillsUsed: [...(player.turnFlags.activeSkillsUsed ?? [])].sort(),
        trackingTargetIds: normalizeSeatSet(player.turnFlags.trackingTargetIds),
        spyGapPendingTargetIds: [...(player.turnFlags.spyGapPendingTargetIds ?? [])].sort()
      },
      aiMemory: normalizeKnown(player.aiMemory)
    }))
  };
}

/** 手动驱动完整对局：turn-by-turn，等效于 balance.mjs 的 runGameLoop。 */
export async function runGame(game, {
  maxRounds = DEFAULT_MAX_ROUNDS,
  onTurnStart = null,
  forkEnabled = true
} = {}) {
  const gameId = game.state.gameId;
  let turnCount = 0;
  let stopped = false;
  while (game.isSessionValid(gameId) && !game.state.isGameOver) {
    if (game.state.currentRound > maxRounds) {
      game.state.isGameOver = true;
      game.state.phase = "gameOver";
      break;
    }
    const player = game.currentPlayer;
    if (!player || !game.state.players.some((entry) => entry.alive)) break;
    turnCount += 1;
    if (onTurnStart && player.alive) {
      const decision = await onTurnStart(game, player, turnCount);
      if (decision === "stop") {
        stopped = true;
        break;
      }
    }
    if (player.alive) await game.takeTurn(player, gameId);
    if (game.state.isGameOver || !game.isSessionValid(gameId)) break;
    await game.advanceTurn();
  }
  return {
    winnerTeam: game.state.winnerTeam,
    rounds: game.state.currentRound,
    turns: turnCount,
    stalled: !game.state.winnerTeam,
    stopped
  };
}

/** 状态分类工具：只读，不参与价值计算。 */
export function classifyState(game, player) {
  const state = game.state;
  const enemies = state.players.filter((entry) => entry.alive && entry.battleTeam !== player.battleTeam);
  const allies = state.players.filter((entry) => entry.alive && entry.battleTeam === player.battleTeam);
  const ownTotal = allies.reduce((sum, entry) => sum + entry.hp + entry.shield, 0);
  const enemyTotal = enemies.reduce((sum, entry) => sum + entry.hp + entry.shield, 0);
  const teamGap = ownTotal - enemyTotal;
  const activeSkill = player.character?.activeSkillIds?.[0] ?? null;
  const activeCost = player.character?.activeCost ?? 0;
  const canReachEnemy = enemies.some((enemy) => enemy.alive && inAttackRange(game, player, enemy));
  return {
    round: state.currentRound,
    hp: player.hp,
    maxHp: player.maxHp,
    shield: player.shield,
    energy: player.energy,
    maxEnergy: player.maxEnergy,
    handCount: player.hand.length,
    hpClass: player.hp <= 1 ? "critical" : player.hp === 2 ? "low" : player.hp >= player.maxHp ? "full" : "healthy",
    handClass: player.hand.length <= 2 ? "low" : player.hand.length <= 5 ? "mid" : "high",
    energyClass: player.energy <= 1 ? "low" : player.energy === 2 ? "mid" : "high",
    canUnlockActiveWithOneEnergy: Boolean(
      activeSkill && activeCost > 0 && player.energy + 1 >= activeCost && player.energy < activeCost
    ),
    canReachEnemy: canReachEnemy,
    teamGap,
    leadClass: teamGap >= 2 ? "lead" : teamGap <= -2 ? "lag" : "close",
    teamSize: allies.length,
    enemyCount: enemies.length,
    characterId: player.characterId
  };
}

/** 干预原语：向手牌加入一张“额外”实体牌（不取自牌堆）。 */
export function addExtraCardToHand(game, player, definitionId) {
  const card = makeExtraCard(definitionId, game.state.gameId);
  player.hand.push(card);
  player.bumpHandVersion(TEST_VERSION_STATE);
  return card;
}

/** 干预原语：从牌堆取出一张指定定义牌并放入手牌（零和获取）。 */
export function takeCardFromDeckToHand(game, player, definitionId) {
  const deck = game.state.deck;
  const index = [...deck.cards].reverse().findIndex((card) => card.definitionId === definitionId);
  if (index < 0) return null;
  const realIndex = deck.cards.length - 1 - index;
  const [card] = deck.cards.splice(realIndex, 1);
  player.hand.push(card);
  player.bumpHandVersion(TEST_VERSION_STATE);
  game.syncDeckAliases();
  return card;
}

/** 干预原语：按真实牌堆规则摸一张牌（获取价值对照臂）。 */
export async function drawOneToHand(game, player, reason = "实验获取") {
  const before = player.hand.length;
  await game.drawCards(player, 1, reason, { silent: true });
  return player.hand.length > before;
}

/** 干预原语：把指定实体牌弃入弃牌堆（弃牌损失实验）。 */
export async function discardCardFromHand(game, player, card, reason = "实验弃置") {
  return game.discardCardFromHand(player, card, reason, { silent: true });
}

/** 干预原语：从玩家手牌移除指定定义的一张实体牌（响应价值对照臂）。 */
export function removeCardFromHandSilently(game, player, definitionId) {
  const index = player.hand.findIndex((card) => card.definitionId === definitionId);
  if (index < 0) return null;
  const [card] = player.hand.splice(index, 1);
  player.bumpHandVersion(TEST_VERSION_STATE);
  game.invalidateCardKnowledge(card.id, player.id);
  return card;
}

/**
 * 响应窗口钩子：在会触发响应窗口的动作入口（playCard / useActiveSkill）
 * 抛出 ForkSignal。原始对局此时尚未发生任何状态变更，可安全克隆分叉。
 */
export class ForkSignal extends Error {
  constructor(spec) {
    super("fork");
    this.spec = spec;
  }
}

export function installWindowHooks(game, hooks) {
  const originalPlayCard = game.playCard.bind(game);
  game.playCard = async (source, card, requestedTargets = [], selection = null, options = {}) => {
    const spec = hooks.playCard?.(game, { type: "playCard", source, card, targets: requestedTargets, selection, options });
    if (spec) throw new ForkSignal(spec);
    return originalPlayCard(source, card, requestedTargets, selection, options);
  };

  const originalUseActiveSkill = game.useActiveSkill.bind(game);
  game.useActiveSkill = async (source, skillId, targets = []) => {
    const spec = hooks.useSkill?.(game, { type: "useSkill", source, skillId, targets });
    if (spec) throw new ForkSignal(spec);
    return originalUseActiveSkill(source, skillId, targets);
  };
}

/** 在分支上继续一个已分叉的动作：执行原动作，再收束当前回合，随后继续整局。 */
export async function continueTurnFromAction(game, spec) {
  const gameId = game.state.gameId;
  const byId = (player) => game.state.players.find((entry) => entry.id === player?.id) ?? null;
  const cardById = (card) => game.state.deck.cards.find((entry) => entry.id === card?.id)
    ?? game.state.deck.discardPile.find((entry) => entry.id === card?.id)
    ?? game.state.deck.resolvingCards.find((entry) => entry.id === card?.id)
    ?? game.state.deck.judgmentZone.find((entry) => entry.id === card?.id)
    ?? game.state.players.flatMap((player) => player.hand).find((entry) => entry.id === card?.id)
    ?? null;
  const source = byId(spec.source);
  let executed = false;
  if (spec.type === "playCard") {
    const card = cardById(spec.card);
    const targets = (spec.targets ?? []).map(byId).filter(Boolean);
    executed = await game.playCard(source, card, targets, spec.selection ?? null, spec.options ?? {});
  } else if (spec.type === "useSkill") {
    const targets = (spec.targets ?? []).map(byId).filter(Boolean);
    executed = await game.useActiveSkill(source, spec.skillId, targets);
  } else {
    throw new Error(`未知窗口动作类型：${spec.type}`);
  }
  if (!game.isSessionValid(gameId) || game.state.isGameOver) return executed;
  if (source.alive && game.currentPlayer?.id === source.id && game.state.phase === "play") {
    await game.takeAiPlayPhase(source, gameId);
  }
  if (!game.isSessionValid(gameId) || game.state.isGameOver) return executed;
  if (!source.alive) {
    await game.advanceTurn();
    return executed;
  }
  await game.handleDiscardPhase(source, gameId);
  if (!game.isSessionValid(gameId) || game.state.isGameOver) return executed;
  game.state.phase = "turnEnd";
  await game.eventDispatcher.emit("turnEnd", { type: "turnEnd", player: source });
  if (!game.isSessionValid(gameId) || game.state.isGameOver) return executed;
  await game.advanceTurn();
  return executed;
}

/** 给指定玩家安装“首个动作强制为指定卡牌动作”的补丁。 */
export function installForcedFirstAction(game, definitionId) {
  const controller = game.aiController;
  const originalTakeAiPlayPhase = game.takeAiPlayPhase.bind(game);
  let used = false;
  game.__forcedLegal = false;
  game.__forcedPlayed = false;
  game.takeAiPlayPhase = async (player, gameId) => {
    if (!used && player.alive && game.currentPlayer?.id === player.id && game.state.phase === "play") {
      used = true;
      const actions = controller.getActionCandidates(player);
      const forced = actions.find((action) => action.type === "card" && action.card?.definitionId === definitionId);
      if (forced) {
        game.__forcedLegal = true;
        const executed = await game.playCard(player, forced.card, forced.targets, forced.selection ?? null);
        game.__forcedPlayed = Boolean(executed);
        if (!game.isSessionValid(gameId)) return;
      }
    }
    return originalTakeAiPlayPhase(player, gameId);
  };
}

/** 给指定玩家安装“首个动作排除指定卡牌”的补丁（最佳其它行动）。 */
export function installBestOtherFirstAction(game, definitionId) {
  const controller = game.aiController;
  const originalSelect = controller.selectAction.bind(controller);
  const originalTakeAiPlayPhase = game.takeAiPlayPhase.bind(game);
  let used = false;
  controller.selectAction = async (player, options = {}) => {
    if (!used) {
      used = true;
      const cardIndex = player.hand.findIndex((card) => card.definitionId === definitionId);
      if (cardIndex >= 0) {
        const [held] = player.hand.splice(cardIndex, 1);
        player.bumpHandVersion(TEST_VERSION_STATE);
        try {
          const remainingCardCounts = controller.knowledge.remainingCounts(player);
          const visible = createInitialSearchState(player.id, controller.game.state, remainingCardCounts);
          const rootActions = controller.getActionCandidates(player);
          return controller.planner.plan(player, visible, rootActions, options);
        } finally {
          player.hand.splice(Math.min(cardIndex, player.hand.length), 0, held);
          player.bumpHandVersion(TEST_VERSION_STATE);
        }
      }
    }
    return originalSelect(player, options);
  };
}

export { ActionLegality };
