/**
 * FiveRealms 正式多线程平衡测试器。
 *
 * 放置位置：tests/balance.mjs
 * npm 命令：npm run test:balance -- [参数]
 * 直接运行：node ./tests/balance.mjs [参数]
 *
 * 特性：
 * - Worker Threads 动态任务池，默认使用全部可用逻辑处理器；
 * - 备用候选对局：默认准备目标局数+10，先完成目标数量后立即终止其余慢局；
 * - 可选尾部投机执行；备用候选模式下默认关闭，避免重复计算同一种子；
 * - 固定全局局号和随机种子，串行/并行使用相同测试样本；
 * - 保留旧 balance-simulation.mjs 的兼容字段，并输出更完整的统计报告；
 * - 不依赖第三方包，不修改正式 Game、AI、规则或牌堆代码。
 */

import { availableParallelism, cpus } from "node:os";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  Worker,
  isMainThread,
  parentPort,
  workerData
} from "node:worker_threads";

const DEFAULT_SEED_BASE = 0x9e3779b9;
const GOLDEN_RATIO_32 = 2654435761;

function makeRandom(seedValue) {
  let seed = seedValue >>> 0;
  return () => (
    (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296
  );
}

function createHeadlessUi() {
  return {
    render() { }, appendLog() { }, cancelPendingInteractions() { },
    async requestResponse() { return false; },
    async requestDiscard(player, count) { return player.hand.slice(0, count); },
    async requestPublicCard(_player, cards) { return cards[0] ?? null; },
    setCurrentCard() { }, setPrompt() { }, setThinking() { }, showGameOver() { },
    queueFeedback() { }, showDying() { }, hideDying() { }, showPublicPool() { },
    hidePublicPool() { }, showJudgment() { }, showDuel() { }, hideDuel() { },
    showPrivateReveal() { }, setFastMode() { }
  };
}

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    stack: error?.stack ?? null
  };
}

function increment(target, key, amount = 1) {
  const normalized = String(key ?? "unknown");
  target[normalized] = (target[normalized] ?? 0) + amount;
}

function incrementNested(target, firstKey, secondKey, amount = 1) {
  const first = String(firstKey ?? "unknown");
  target[first] ??= {};
  increment(target[first], secondKey, amount);
}

function mergeNumericMap(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    target[key] = (target[key] ?? 0) + (Number(value) || 0);
  }
}

function mergeNestedNumericMap(target, source) {
  for (const [firstKey, values] of Object.entries(source ?? {})) {
    target[firstKey] ??= {};
    mergeNumericMap(target[firstKey], values);
  }
}

function createLocalResult(index) {
  return {
    index,
    winnerTeam: null,
    winningSide: null,
    smallTeamId: null,
    startingSeat: null,
    startingTeam: null,
    startingSide: null,
    startingTeamWon: false,
    smallWins: 0,
    largeWins: 0,
    dawnWins: 0,
    duskWins: 0,
    stalled: 0,
    deathCleanupViolations: 0,
    rounds: 0,
    turns: 0,
    reshuffles: 0,
    equipmentUses: 0,
    equipmentByType: {},
    attacks: 0,
    cardsPlayed: 0,
    damageDealt: 0,
    damageTaken: 0,
    healingDone: 0,
    deaths: 0,
    survivors: 0,
    dyingEntries: 0,
    rescues: 0,
    smallDamage: 0,
    largeDamage: 0,
    smallDamageTaken: 0,
    largeDamageTaken: 0,
    smallHealing: 0,
    largeHealing: 0,
    smallCardsPlayed: 0,
    largeCardsPlayed: 0,
    smallAttacks: 0,
    largeAttacks: 0,
    cardUses: {
      total: 0,
      resolved: 0,
      cancelled: 0,
      byDefinition: {},
      resolvedByDefinition: {},
      cancelledByDefinition: {},
      byCategory: {},
      byGeneral: {}
    },
    cardMoves: {
      total: 0,
      byTransition: {},
      byReason: {}
    },
    damageEvents: {
      events: 0,
      hpDamage: 0,
      shieldAbsorbed: 0,
      byType: {},
      preventedBy: {}
    },
    healEvents: {
      events: 0,
      amount: 0,
      dyingRescueAmount: 0,
      byReason: {}
    },
    energyEvents: {
      events: 0,
      amount: 0,
      byReason: {}
    },
    skillUses: {
      total: 0,
      bySkill: {},
      byGeneral: {}
    },
    players: [],
    stallSnapshot: null,
    durationMs: 0
  };
}

async function runOneGame(Game, index, config) {
  const startedAt = performance.now();
  const local = createLocalResult(index);
  let game = null;

  try {
    const random = makeRandom(config.seedBase ^ (index * GOLDEN_RATIO_32));
    game = new Game(createHeadlessUi(), random);
    game.simulationMode = true;
    game.animationFastMode = true;
    game.aiSearchNodeBudgetOverride = config.searchNodeBudget;
    game.cleanupManager.delay = async () => !game.state.isDisposed;

    const candidates = game.startSelection();
    if (!candidates.length) throw new Error(`第 ${index} 局没有可选角色`);
    game.state.players[0].controllerType = "ai";

    game.eventBus.on("afterCardMove", `balance:move:${index}`, (event) => {
      if (config.detailed) {
        local.cardMoves.total += 1;
        increment(local.cardMoves.byTransition, `${event.from ?? "unknown"}->${event.to ?? "unknown"}`);
        increment(local.cardMoves.byReason, event.reason ?? "unknown");
      }
      if (event.to === "equipment") {
        local.equipmentUses += 1;
        increment(local.equipmentByType, event.card?.definitionId ?? "unknown");
      }
    });

    if (config.detailed) game.eventBus.on("cardUsed", `balance:card-used:${index}`, (event) => {
      const definitionId = event.card?.definitionId ?? "unknown";
      const category = event.card?.category ?? "unknown";
      const generalId = event.source?.generalId ?? "unknown";
      local.cardUses.total += 1;
      increment(local.cardUses.byDefinition, definitionId);
      increment(local.cardUses.byCategory, category);
      incrementNested(local.cardUses.byGeneral, generalId, definitionId);
      if (event.resolved && !event.cancelled) {
        local.cardUses.resolved += 1;
        increment(local.cardUses.resolvedByDefinition, definitionId);
      } else {
        local.cardUses.cancelled += 1;
        increment(local.cardUses.cancelledByDefinition, definitionId);
      }
    });

    if (config.detailed) game.eventBus.on("afterDamage", `balance:damage:${index}`, (event) => {
      local.damageEvents.events += 1;
      local.damageEvents.hpDamage += Number(event.actualAmount) || 0;
      local.damageEvents.shieldAbsorbed += Number(event.shieldAbsorbed) || 0;
      increment(local.damageEvents.byType, event.damageType ?? "normal", Number(event.actualAmount) || 0);
      if (event.preventedBy) increment(local.damageEvents.preventedBy, event.preventedBy);
    });

    if (config.detailed) game.eventBus.on("afterHeal", `balance:heal:${index}`, (event) => {
      const amount = Number(event.actualAmount) || 0;
      local.healEvents.events += 1;
      local.healEvents.amount += amount;
      if (event.isDyingRescue) local.healEvents.dyingRescueAmount += amount;
      increment(local.healEvents.byReason, event.reason ?? "unknown", amount);
    });

    if (config.detailed) game.eventBus.on("afterGainEnergy", `balance:energy:${index}`, (event) => {
      const amount = Number(event.actualAmount) || 0;
      local.energyEvents.events += 1;
      local.energyEvents.amount += amount;
      increment(local.energyEvents.byReason, event.reason ?? "unknown", amount);
    });

    game.eventBus.on("turnEnd", `balance:turn:${index}`, () => {
      local.turns += 1;
    });

    game.eventBus.on("playerDying", `balance:dying:${index}`, () => {
      local.dyingEntries += 1;
    });

    game.eventBus.on("playerRescued", `balance:rescue:${index}`, () => {
      local.rescues += 1;
    });

    game.eventBus.on("playerDead", `balance:dead:${index}`, (event) => {
      local.deaths += 1;
      if (event.target.hand.length || event.target.equipment) {
        local.deathCleanupViolations += 1;
      }
    });

    game.eventBus.on("roundStart", `balance:round-cap:${index}`, (event) => {
      if (event.round > config.maxRounds) {
        game.state.isGameOver = true;
        game.state.phase = "gameOver";
      }
    });

    if (config.detailed && typeof game.useActiveSkill === "function") {
      const originalUseActiveSkill = game.useActiveSkill.bind(game);
      game.useActiveSkill = async (source, skillId, targets = []) => {
        const used = await originalUseActiveSkill(source, skillId, targets);
        if (used) {
          const generalId = source?.generalId ?? "unknown";
          local.skillUses.total += 1;
          increment(local.skillUses.bySkill, skillId ?? "unknown");
          incrementNested(local.skillUses.byGeneral, generalId, skillId ?? "unknown");
        }
        return used;
      };
    }

    await game.confirmGeneral(candidates[index % candidates.length].id);
    await game.loopPromise;

    const smallTeam = ["dawn", "dusk"].find((team) => (
      game.state.players.filter((player) => player.battleTeam === team).length === 2
    ));
    const winnerTeam = game.state.winnerTeam ?? null;
    const winningSide = winnerTeam ? (winnerTeam === smallTeam ? "small" : "large") : null;
    const startingPlayer = game.state.players[game.state.startingPlayerIndex] ?? null;
    const startingSide = startingPlayer
      ? (startingPlayer.battleTeam === smallTeam ? "small" : "large")
      : null;

    local.smallTeamId = smallTeam ?? null;
    local.winnerTeam = winnerTeam;
    local.winningSide = winningSide;
    local.startingSeat = startingPlayer?.seatIndex ?? null;
    local.startingTeam = startingPlayer?.battleTeam ?? null;
    local.startingSide = startingSide;
    local.startingTeamWon = Boolean(winnerTeam && startingPlayer?.battleTeam === winnerTeam);
    if (winnerTeam === "dawn") local.dawnWins = 1;
    if (winnerTeam === "dusk") local.duskWins = 1;

    if (!winnerTeam) {
      local.stalled = 1;
      local.stallSnapshot = {
        index,
        round: game.state.currentRound,
        startingSeat: local.startingSeat,
        smallTeam,
        players: game.state.players.map((player) => ({
          team: player.battleTeam,
          side: player.battleTeam === smallTeam ? "small" : "large",
          seat: player.seatIndex,
          generalId: player.generalId,
          alive: player.alive,
          hp: player.hp,
          hand: player.hand.map((card) => card.definitionId),
          equipment: player.equipment?.definitionId ?? null
        }))
      };
    } else if (winningSide === "small") {
      local.smallWins = 1;
    } else {
      local.largeWins = 1;
    }

    local.rounds = game.state.currentRound;
    local.reshuffles = game.state.deck.reshuffleCount;
    local.survivors = game.state.players.filter((player) => player.alive).length;

    local.players = game.state.players.map((player) => {
      const side = player.battleTeam === smallTeam ? "small" : "large";
      const stats = player.statistics ?? {};
      const record = {
        seat: player.seatIndex,
        team: player.battleTeam,
        side,
        generalId: player.generalId,
        generalName: player.name,
        won: Boolean(winnerTeam && player.battleTeam === winnerTeam),
        started: player.id === startingPlayer?.id,
        alive: player.alive,
        finalHp: player.hp,
        maxHp: player.maxHp,
        finalShield: player.shield,
        finalEnergy: player.energy,
        handCount: player.hand.length,
        equipment: player.equipment?.definitionId ?? null,
        damageDealt: Number(stats.damageDealt) || 0,
        damageTaken: Number(stats.damageTaken) || 0,
        healingDone: Number(stats.healingDone) || 0,
        cardsPlayed: Number(stats.cardsPlayed) || 0,
        assaultsUsed: Number(stats.assaultsUsed) || 0
      };

      local.cardsPlayed += record.cardsPlayed;
      local.damageDealt += record.damageDealt;
      local.damageTaken += record.damageTaken;
      local.healingDone += record.healingDone;
      local.attacks += record.assaultsUsed;
      const prefix = side === "small" ? "small" : "large";
      local[`${prefix}Damage`] += record.damageDealt;
      local[`${prefix}DamageTaken`] += record.damageTaken;
      local[`${prefix}Healing`] += record.healingDone;
      local[`${prefix}CardsPlayed`] += record.cardsPlayed;
      local[`${prefix}Attacks`] += record.assaultsUsed;
      return record;
    });

    return local;
  } finally {
    local.durationMs = performance.now() - startedAt;
    game?.dispose();
  }
}

async function startWorker() {
  const { Game } = await import("../js/core/Game.js");
  const config = workerData.config;

  parentPort.on("message", async (message) => {
    if (message?.type !== "run") return;
    const { index, taskId } = message;
    parentPort.postMessage({ type: "started", index, taskId });
    try {
      const result = await runOneGame(Game, index, config);
      parentPort.postMessage({ type: "result", index, taskId, result });
    } catch (error) {
      parentPort.postMessage({
        type: "gameError",
        index,
        taskId,
        error: serializeError(error)
      });
    }
  });

  parentPort.postMessage({ type: "ready" });
}

function parseCli(argv) {
  const parsed = {};
  const aliases = new Map([
    ["-g", "games"], ["-w", "workers"], ["-n", "search-node-budget"],
    ["-o", "output"], ["-h", "help"]
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    let token = argv[index];
    if (aliases.has(token)) token = `--${aliases.get(token)}`;
    if (!token.startsWith("--")) throw new Error(`无法识别的参数：${token}`);
    if (token.startsWith("--no-")) {
      parsed[token.slice(5)] = false;
      continue;
    }
    const equalsIndex = token.indexOf("=");
    if (equalsIndex >= 0) {
      parsed[token.slice(2, equalsIndex)] = token.slice(equalsIndex + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("-")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = true;
    }
  }
  return parsed;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function parseInteger(name, value, { minimum = Number.MIN_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${name} 必须是 ${minimum}～${maximum} 范围内的整数，当前值：${value}`);
  }
  return number;
}

function parseNumber(name, value, { minimum = -Infinity, maximum = Infinity } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`${name} 必须是 ${minimum}～${maximum} 范围内的数字，当前值：${value}`);
  }
  return number;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`无法识别布尔值：${value}`);
}

function logicalCpuCount() {
  try { return availableParallelism(); }
  catch { return cpus().length; }
}

function buildConfig(cli) {
  const cpuCount = logicalCpuCount();
  const reserveCores = parseInteger(
    "reserve-cores",
    firstDefined(cli["reserve-cores"], process.env.FIVE_REALMS_BALANCE_RESERVE_CORES, 0),
    { minimum: 0, maximum: Math.max(0, cpuCount - 1) }
  );
  const games = parseInteger(
    "games",
    firstDefined(cli.games, process.env.FIVE_REALMS_GAMES, 200),
    { minimum: 1 }
  );
  const reserveGames = parseInteger(
    "reserve-games",
    firstDefined(cli["reserve-games"], process.env.FIVE_REALMS_BALANCE_RESERVE_GAMES, 10),
    { minimum: 0 }
  );
  const candidateGames = games + reserveGames;
  const rawWorkers = firstDefined(cli.workers, process.env.FIVE_REALMS_BALANCE_WORKERS, "auto");
  const requestedWorkers = rawWorkers === "auto"
    ? Math.max(1, cpuCount - reserveCores)
    : parseInteger("workers", rawWorkers, { minimum: 1 });
  const minSmallWinRate = parseNumber(
    "min-small-win-rate",
    firstDefined(cli["min-small-win-rate"], process.env.FIVE_REALMS_BALANCE_MIN_WIN_RATE, 40),
    { minimum: 0, maximum: 100 }
  );
  const maxSmallWinRate = parseNumber(
    "max-small-win-rate",
    firstDefined(cli["max-small-win-rate"], process.env.FIVE_REALMS_BALANCE_MAX_WIN_RATE, 60),
    { minimum: 0, maximum: 100 }
  );
  if (minSmallWinRate > maxSmallWinRate) throw new Error("min-small-win-rate 不能大于 max-small-win-rate");

  return Object.freeze({
    games,
    reserveGames,
    candidateGames,
    workers: Math.min(candidateGames, requestedWorkers),
    logicalCpuCount: cpuCount,
    reserveCores,
    startIndex: parseInteger("start-index", firstDefined(cli["start-index"], process.env.FIVE_REALMS_START_INDEX, 0), { minimum: 0 }),
    seedBase: parseInteger("seed-base", firstDefined(cli["seed-base"], process.env.FIVE_REALMS_SEED_BASE, DEFAULT_SEED_BASE), { minimum: 0, maximum: 0xffffffff }),
    searchNodeBudget: parseInteger("search-node-budget", firstDefined(cli["search-node-budget"], process.env.FIVE_REALMS_SEARCH_NODE_BUDGET, 1000), { minimum: 1 }),
    maxRounds: parseInteger("max-rounds", firstDefined(cli["max-rounds"], process.env.FIVE_REALMS_BALANCE_MAX_ROUNDS, 250), { minimum: 1 }),
    minSmallWinRate,
    maxSmallWinRate,
    maxStalledGames: parseInteger("max-stalled-games", firstDefined(cli["max-stalled-games"], process.env.FIVE_REALMS_BALANCE_MAX_STALLED_GAMES, 0), { minimum: 0 }),
    maxDeathCleanupViolations: parseInteger("max-death-cleanup-violations", firstDefined(cli["max-death-cleanup-violations"], process.env.FIVE_REALMS_BALANCE_MAX_DEATH_CLEANUP_VIOLATIONS, 0), { minimum: 0 }),
    reportOnly: parseBoolean(firstDefined(cli["report-only"], process.env.FIVE_REALMS_BALANCE_REPORT_ONLY), false),
    progress: parseBoolean(firstDefined(cli.progress, process.env.FIVE_REALMS_BALANCE_PROGRESS), true),
    progressEvery: parseInteger("progress-every", firstDefined(cli["progress-every"], process.env.FIVE_REALMS_BALANCE_PROGRESS_EVERY, 10), { minimum: 1 }),
    gameTimeoutMs: parseInteger("game-timeout-ms", firstDefined(cli["game-timeout-ms"], process.env.FIVE_REALMS_BALANCE_GAME_TIMEOUT_MS, 0), { minimum: 0 }),
    retries: parseInteger("retries", firstDefined(cli.retries, process.env.FIVE_REALMS_BALANCE_RETRIES, 0), { minimum: 0, maximum: 20 }),
    failFast: parseBoolean(firstDefined(cli["fail-fast"], process.env.FIVE_REALMS_BALANCE_FAIL_FAST), false),
    stallSamplesLimit: parseInteger("stall-samples", firstDefined(cli["stall-samples"], process.env.FIVE_REALMS_BALANCE_STALL_SAMPLES, 3), { minimum: 0 }),
    errorSamplesLimit: parseInteger("error-samples", firstDefined(cli["error-samples"], process.env.FIVE_REALMS_BALANCE_ERROR_SAMPLES, 5), { minimum: 0 }),
    slowGameSamplesLimit: parseInteger("slow-game-samples", firstDefined(cli["slow-game-samples"], process.env.FIVE_REALMS_BALANCE_SLOW_GAME_SAMPLES, 10), { minimum: 0 }),
    includeGameRecords: parseBoolean(firstDefined(cli["include-game-records"], process.env.FIVE_REALMS_BALANCE_INCLUDE_GAME_RECORDS), false),
    gameRecordsLimit: parseInteger("game-records-limit", firstDefined(cli["game-records-limit"], process.env.FIVE_REALMS_BALANCE_GAME_RECORDS_LIMIT, 0), { minimum: 0 }),
    detailed: parseBoolean(firstDefined(cli.detailed, process.env.FIVE_REALMS_BALANCE_DETAILED), true),
    summary: parseBoolean(firstDefined(cli.summary, process.env.FIVE_REALMS_BALANCE_SUMMARY), true),
    stdout: parseBoolean(firstDefined(cli.stdout, process.env.FIVE_REALMS_BALANCE_STDOUT), true),
    pretty: parseBoolean(firstDefined(cli.pretty, process.env.FIVE_REALMS_BALANCE_PRETTY), true),
    tailSpeculation: parseBoolean(
      firstDefined(cli["tail-speculation"], process.env.FIVE_REALMS_BALANCE_TAIL_SPECULATION),
      reserveGames === 0
    ),
    tailSpeculationMinMs: parseInteger("tail-speculation-min-ms", firstDefined(cli["tail-speculation-min-ms"], process.env.FIVE_REALMS_BALANCE_TAIL_SPECULATION_MIN_MS, 1000), { minimum: 0 }),
    tailSpeculationFactor: parseNumber("tail-speculation-factor", firstDefined(cli["tail-speculation-factor"], process.env.FIVE_REALMS_BALANCE_TAIL_SPECULATION_FACTOR, 0.75), { minimum: 0, maximum: 10 }),
    tailMaxCopies: parseInteger("tail-max-copies", firstDefined(cli["tail-max-copies"], process.env.FIVE_REALMS_BALANCE_TAIL_MAX_COPIES, 0), { minimum: 0 }),
    tailCheckMs: parseInteger("tail-check-ms", firstDefined(cli["tail-check-ms"], process.env.FIVE_REALMS_BALANCE_TAIL_CHECK_MS, 200), { minimum: 20 }),
    tailStatusMs: parseInteger("tail-status-ms", firstDefined(cli["tail-status-ms"], process.env.FIVE_REALMS_BALANCE_TAIL_STATUS_MS, 2000), { minimum: 0 }),
    output: firstDefined(cli.output, process.env.FIVE_REALMS_BALANCE_OUTPUT, null)
  });
}

function createTotals() {
  return {
    smallWins: 0, largeWins: 0, dawnWins: 0, duskWins: 0,
    stalled: 0, failed: 0, deathCleanupViolations: 0,
    rounds: 0, turns: 0, reshuffles: 0, equipmentUses: 0,
    equipmentByType: {}, attacks: 0, cardsPlayed: 0,
    damageDealt: 0, damageTaken: 0, healingDone: 0,
    deaths: 0, survivors: 0, dyingEntries: 0, rescues: 0,
    smallDamage: 0, largeDamage: 0, smallDamageTaken: 0, largeDamageTaken: 0,
    smallHealing: 0, largeHealing: 0, smallCardsPlayed: 0, largeCardsPlayed: 0,
    smallAttacks: 0, largeAttacks: 0,
    smallTeamIdentity: { dawn: 0, dusk: 0 },
    startingSide: { small: { games: 0, wins: 0 }, large: { games: 0, wins: 0 } },
    startingSeat: {},
    cardUses: { total: 0, resolved: 0, cancelled: 0, byDefinition: {}, resolvedByDefinition: {}, cancelledByDefinition: {}, byCategory: {}, byGeneral: {} },
    cardMoves: { total: 0, byTransition: {}, byReason: {} },
    damageEvents: { events: 0, hpDamage: 0, shieldAbsorbed: 0, byType: {}, preventedBy: {} },
    healEvents: { events: 0, amount: 0, dyingRescueAmount: 0, byReason: {} },
    energyEvents: { events: 0, amount: 0, byReason: {} },
    skillUses: { total: 0, bySkill: {}, byGeneral: {} },
    generalStats: {}, seatStats: {},
    stallSnapshots: [], errorSamples: [],
    durationsMs: [], roundValues: [], reshuffleValues: [], turnValues: [],
    gameRecords: [],
    speculativeTasksStarted: 0, speculativeWins: 0,
    speculativeResultsDiscarded: 0, speculativeErrorsIgnored: 0,
    speculativeDiscardedComputeMs: 0,
    maxBusyWorkers: 0, maxSpeculativeWorkers: 0,
    reserveCandidatesAbandoned: 0, reserveCandidateIndexes: [],
    reserveCandidateFailures: 0
  };
}

function ensurePlayerAggregate(container, key) {
  const normalized = String(key ?? "unknown");
  container[normalized] ??= {
    appearances: 0, wins: 0, smallAppearances: 0, smallWins: 0,
    largeAppearances: 0, largeWins: 0, dawnAppearances: 0, dawnWins: 0,
    duskAppearances: 0, duskWins: 0, starts: 0, startWins: 0,
    survivals: 0, finalHp: 0, maxHp: 0, finalShield: 0, finalEnergy: 0,
    finalHandCards: 0, equipmentAtEnd: 0, damageDealt: 0, damageTaken: 0,
    healingDone: 0, cardsPlayed: 0, assaultsUsed: 0,
    cardsByDefinition: {}, skillsById: {}
  };
  return container[normalized];
}

function mergePlayerAggregate(aggregate, player) {
  aggregate.appearances += 1;
  if (player.won) aggregate.wins += 1;
  if (player.side === "small") {
    aggregate.smallAppearances += 1;
    if (player.won) aggregate.smallWins += 1;
  } else {
    aggregate.largeAppearances += 1;
    if (player.won) aggregate.largeWins += 1;
  }
  if (player.team === "dawn") {
    aggregate.dawnAppearances += 1;
    if (player.won) aggregate.dawnWins += 1;
  } else {
    aggregate.duskAppearances += 1;
    if (player.won) aggregate.duskWins += 1;
  }
  if (player.started) {
    aggregate.starts += 1;
    if (player.won) aggregate.startWins += 1;
  }
  if (player.alive) aggregate.survivals += 1;
  aggregate.finalHp += player.finalHp;
  aggregate.maxHp += player.maxHp;
  aggregate.finalShield += player.finalShield;
  aggregate.finalEnergy += player.finalEnergy;
  aggregate.finalHandCards += player.handCount;
  if (player.equipment) aggregate.equipmentAtEnd += 1;
  aggregate.damageDealt += player.damageDealt;
  aggregate.damageTaken += player.damageTaken;
  aggregate.healingDone += player.healingDone;
  aggregate.cardsPlayed += player.cardsPlayed;
  aggregate.assaultsUsed += player.assaultsUsed;
}

function mergeResult(totals, result, config) {
  for (const key of [
    "smallWins", "largeWins", "dawnWins", "duskWins", "stalled",
    "deathCleanupViolations", "rounds", "turns", "reshuffles", "equipmentUses",
    "attacks", "cardsPlayed", "damageDealt", "damageTaken", "healingDone",
    "deaths", "survivors", "dyingEntries", "rescues", "smallDamage", "largeDamage",
    "smallDamageTaken", "largeDamageTaken", "smallHealing", "largeHealing",
    "smallCardsPlayed", "largeCardsPlayed", "smallAttacks", "largeAttacks"
  ]) totals[key] += result[key] ?? 0;

  increment(totals.smallTeamIdentity, result.smallTeamId ?? "unknown");
  if (result.startingSide && totals.startingSide[result.startingSide]) {
    totals.startingSide[result.startingSide].games += 1;
    if (result.startingTeamWon) totals.startingSide[result.startingSide].wins += 1;
  }
  if (result.startingSeat !== null) {
    const seat = String(result.startingSeat);
    totals.startingSeat[seat] ??= { games: 0, wins: 0 };
    totals.startingSeat[seat].games += 1;
    if (result.startingTeamWon) totals.startingSeat[seat].wins += 1;
  }

  mergeNumericMap(totals.equipmentByType, result.equipmentByType);
  totals.cardUses.total += result.cardUses?.total ?? 0;
  totals.cardUses.resolved += result.cardUses?.resolved ?? 0;
  totals.cardUses.cancelled += result.cardUses?.cancelled ?? 0;
  mergeNumericMap(totals.cardUses.byDefinition, result.cardUses?.byDefinition);
  mergeNumericMap(totals.cardUses.resolvedByDefinition, result.cardUses?.resolvedByDefinition);
  mergeNumericMap(totals.cardUses.cancelledByDefinition, result.cardUses?.cancelledByDefinition);
  mergeNumericMap(totals.cardUses.byCategory, result.cardUses?.byCategory);
  mergeNestedNumericMap(totals.cardUses.byGeneral, result.cardUses?.byGeneral);

  totals.cardMoves.total += result.cardMoves?.total ?? 0;
  mergeNumericMap(totals.cardMoves.byTransition, result.cardMoves?.byTransition);
  mergeNumericMap(totals.cardMoves.byReason, result.cardMoves?.byReason);

  for (const section of ["damageEvents", "healEvents", "energyEvents"]) {
    for (const [key, value] of Object.entries(result[section] ?? {})) {
      if (typeof value === "number") totals[section][key] = (totals[section][key] ?? 0) + value;
      else if (value && typeof value === "object") mergeNumericMap(totals[section][key], value);
    }
  }
  totals.skillUses.total += result.skillUses?.total ?? 0;
  mergeNumericMap(totals.skillUses.bySkill, result.skillUses?.bySkill);
  mergeNestedNumericMap(totals.skillUses.byGeneral, result.skillUses?.byGeneral);

  for (const player of result.players ?? []) {
    const general = ensurePlayerAggregate(totals.generalStats, player.generalId);
    mergePlayerAggregate(general, player);
    const seat = ensurePlayerAggregate(totals.seatStats, player.seat);
    mergePlayerAggregate(seat, player);
  }
  for (const [generalId, cards] of Object.entries(result.cardUses?.byGeneral ?? {})) {
    mergeNumericMap(ensurePlayerAggregate(totals.generalStats, generalId).cardsByDefinition, cards);
  }
  for (const [generalId, skills] of Object.entries(result.skillUses?.byGeneral ?? {})) {
    mergeNumericMap(ensurePlayerAggregate(totals.generalStats, generalId).skillsById, skills);
  }

  if (result.stallSnapshot && totals.stallSnapshots.length < config.stallSamplesLimit) {
    totals.stallSnapshots.push(result.stallSnapshot);
  }
  totals.durationsMs.push(result.durationMs);
  totals.roundValues.push(result.rounds);
  totals.reshuffleValues.push(result.reshuffles);
  totals.turnValues.push(result.turns);
  totals.gameRecords.push({
    index: result.index,
    durationMs: result.durationMs,
    rounds: result.rounds,
    turns: result.turns,
    winnerTeam: result.winnerTeam,
    winningSide: result.winningSide,
    smallTeamId: result.smallTeamId,
    startingSeat: result.startingSeat,
    startingSide: result.startingSide,
    startingTeamWon: result.startingTeamWon,
    reshuffles: result.reshuffles,
    cardsPlayed: result.cardsPlayed,
    damageDealt: result.damageDealt,
    healingDone: result.healingDone,
    assaults: result.attacks,
    dyingEntries: result.dyingEntries,
    rescues: result.rescues,
    deaths: result.deaths,
    stalled: Boolean(result.stalled)
  });
}

function percentile(sortedValues, ratio) {
  if (!sortedValues.length) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * ratio) - 1));
  return sortedValues[index];
}

function round(value, digits = 2) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(digits)) : 0;
}

function rate(numerator, denominator, digits = 1) {
  return denominator ? round(numerator / denominator * 100, digits) : 0;
}

function numericSummary(values, digits = 2) {
  const sorted = [...values].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    count: sorted.length,
    total: round(sum, digits),
    average: sorted.length ? round(sum / sorted.length, digits) : 0,
    minimum: round(sorted[0] ?? 0, digits),
    p25: round(percentile(sorted, 0.25), digits),
    median: round(percentile(sorted, 0.5), digits),
    p75: round(percentile(sorted, 0.75), digits),
    p90: round(percentile(sorted, 0.9), digits),
    p95: round(percentile(sorted, 0.95), digits),
    p99: round(percentile(sorted, 0.99), digits),
    maximum: round(sorted.at(-1) ?? 0, digits)
  };
}

function exactHistogram(values) {
  const result = {};
  for (const value of values) increment(result, value);
  return Object.fromEntries(Object.entries(result).sort((a, b) => Number(a[0]) - Number(b[0])));
}

function finalizePlayerAggregates(stats) {
  return Object.fromEntries(Object.entries(stats).map(([key, value]) => {
    const n = Math.max(1, value.appearances);
    return [key, {
      appearances: value.appearances,
      wins: value.wins,
      winRate: rate(value.wins, value.appearances),
      smallAppearances: value.smallAppearances,
      smallWins: value.smallWins,
      smallWinRate: rate(value.smallWins, value.smallAppearances),
      largeAppearances: value.largeAppearances,
      largeWins: value.largeWins,
      largeWinRate: rate(value.largeWins, value.largeAppearances),
      dawnAppearances: value.dawnAppearances,
      dawnWinRate: rate(value.dawnWins, value.dawnAppearances),
      duskAppearances: value.duskAppearances,
      duskWinRate: rate(value.duskWins, value.duskAppearances),
      starts: value.starts,
      startWinRate: rate(value.startWins, value.starts),
      survivalRate: rate(value.survivals, value.appearances),
      averageFinalHp: round(value.finalHp / n),
      averageMaxHp: round(value.maxHp / n),
      averageFinalShield: round(value.finalShield / n),
      averageFinalEnergy: round(value.finalEnergy / n),
      averageFinalHandCards: round(value.finalHandCards / n),
      endingEquipmentRate: rate(value.equipmentAtEnd, value.appearances),
      averageDamageDealt: round(value.damageDealt / n),
      averageDamageTaken: round(value.damageTaken / n),
      averageHealingDone: round(value.healingDone / n),
      averageCardsPlayed: round(value.cardsPlayed / n),
      averageAssaultsUsed: round(value.assaultsUsed / n),
      totalDamageDealt: value.damageDealt,
      totalDamageTaken: value.damageTaken,
      totalHealingDone: value.healingDone,
      totalCardsPlayed: value.cardsPlayed,
      totalAssaultsUsed: value.assaultsUsed,
      cardsByDefinition: value.cardsByDefinition,
      skillsById: value.skillsById
    }];
  }).sort((a, b) => a[0].localeCompare(b[0])));
}

function buildReport(config, totals, elapsedMs) {
  const simulatedGames = totals.durationsMs.length;
  const completedGames = totals.smallWins + totals.largeWins;
  const completedDenominator = Math.max(1, completedGames);
  const simulatedDenominator = Math.max(1, simulatedGames);
  const playerDenominator = Math.max(1, simulatedGames * 5);
  const durationStats = numericSummary(totals.durationsMs, 3);
  const roundStats = numericSummary(totals.roundValues, 2);
  const turnStats = numericSummary(totals.turnValues, 2);
  const reshuffleStats = numericSummary(totals.reshuffleValues, 2);
  const slowestGames = [...totals.gameRecords]
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, config.slowGameSamplesLimit);
  const sortedGameRecords = [...totals.gameRecords].sort((a, b) => a.index - b.index);
  const gameRecords = config.includeGameRecords
    ? (config.gameRecordsLimit > 0
      ? sortedGameRecords.slice(0, config.gameRecordsLimit)
      : sortedGameRecords)
    : undefined;

  const legacy = {
    games: config.games,
    simulatedGames,
    completedGames,
    stalledGames: totals.stalled,
    failedGames: totals.failed,
    deathCleanupViolations: totals.deathCleanupViolations,
    stalledSamples: totals.stallSnapshots,
    errorSamples: totals.errorSamples,
    smallTeamWins: totals.smallWins,
    largeTeamWins: totals.largeWins,
    smallTeamWinRate: rate(totals.smallWins, completedDenominator),
    largeTeamWinRate: rate(totals.largeWins, completedDenominator),
    averageRounds: round(totals.rounds / simulatedDenominator),
    averageReshuffles: round(totals.reshuffles / simulatedDenominator),
    averageEquipmentUses: round(totals.equipmentUses / simulatedDenominator),
    equipmentUsesByType: totals.equipmentByType,
    averageAssaults: round(totals.attacks / simulatedDenominator),
    rescueRate: rate(totals.rescues, totals.dyingEntries),
    averageSmallTeamDamage: round(totals.smallDamage / simulatedDenominator),
    averageLargeTeamDamage: round(totals.largeDamage / simulatedDenominator),
    averageSmallTeamHealing: round(totals.smallHealing / simulatedDenominator),
    averageLargeTeamHealing: round(totals.largeHealing / simulatedDenominator),
    averageSmallTeamAssaults: round(totals.smallAttacks / simulatedDenominator),
    averageLargeTeamAssaults: round(totals.largeAttacks / simulatedDenominator)
  };

  return {
    generatedAt: new Date().toISOString(),
    config: {
      games: config.games, reserveGames: config.reserveGames, candidateGames: config.candidateGames,
      workers: config.workers, logicalCpuCount: config.logicalCpuCount,
      reserveCores: config.reserveCores, startIndex: config.startIndex,
      endIndex: config.startIndex + config.games - 1,
      seedBase: config.seedBase, seedBaseHex: `0x${config.seedBase.toString(16)}`,
      searchNodeBudget: config.searchNodeBudget, maxRounds: config.maxRounds,
      minSmallWinRate: config.minSmallWinRate, maxSmallWinRate: config.maxSmallWinRate,
      maxStalledGames: config.maxStalledGames,
      maxDeathCleanupViolations: config.maxDeathCleanupViolations,
      reportOnly: config.reportOnly, gameTimeoutMs: config.gameTimeoutMs,
      retries: config.retries, failFast: config.failFast, detailed: config.detailed,
      includeGameRecords: config.includeGameRecords, gameRecordsLimit: config.gameRecordsLimit,
      tailSpeculation: config.tailSpeculation,
      tailSpeculationMinMs: config.tailSpeculationMinMs,
      tailSpeculationFactor: config.tailSpeculationFactor,
      tailMaxCopies: config.tailMaxCopies,
      tailCheckMs: config.tailCheckMs,
      tailStatusMs: config.tailStatusMs
    },
    ...legacy,
    outcome: {
      smallTeam: { wins: totals.smallWins, losses: totals.largeWins, winRate: rate(totals.smallWins, completedGames) },
      largeTeam: { wins: totals.largeWins, losses: totals.smallWins, winRate: rate(totals.largeWins, completedGames) },
      dawn: { wins: totals.dawnWins, winRate: rate(totals.dawnWins, completedGames) },
      dusk: { wins: totals.duskWins, winRate: rate(totals.duskWins, completedGames) },
      smallTeamIdentity: totals.smallTeamIdentity,
      startingSide: {
        small: { ...totals.startingSide.small, winRate: rate(totals.startingSide.small.wins, totals.startingSide.small.games) },
        large: { ...totals.startingSide.large, winRate: rate(totals.startingSide.large.wins, totals.startingSide.large.games) }
      },
      startingSeat: Object.fromEntries(Object.entries(totals.startingSeat).map(([seat, value]) => [seat, { ...value, winRate: rate(value.wins, value.games) }]))
    },
    gameFlow: {
      rounds: roundStats,
      roundHistogram: exactHistogram(totals.roundValues),
      turns: turnStats,
      reshuffles: reshuffleStats,
      totalRounds: totals.rounds,
      totalTurns: totals.turns,
      totalReshuffles: totals.reshuffles
    },
    combat: {
      totalDamageDealt: totals.damageDealt,
      totalDamageTaken: totals.damageTaken,
      damageAccountingDifference: totals.damageDealt - totals.damageTaken,
      totalHealingDone: totals.healingDone,
      totalAssaults: totals.attacks,
      totalDeaths: totals.deaths,
      totalSurvivors: totals.survivors,
      survivalRate: rate(totals.survivors, playerDenominator),
      dyingEntries: totals.dyingEntries,
      rescues: totals.rescues,
      rescueRate: rate(totals.rescues, totals.dyingEntries),
      bySide: {
        small: {
          damageDealt: totals.smallDamage,
          damageTaken: totals.smallDamageTaken,
          healingDone: totals.smallHealing,
          cardsPlayed: totals.smallCardsPlayed,
          assaults: totals.smallAttacks,
          averageDamagePerGame: round(totals.smallDamage / simulatedDenominator),
          averageHealingPerGame: round(totals.smallHealing / simulatedDenominator)
        },
        large: {
          damageDealt: totals.largeDamage,
          damageTaken: totals.largeDamageTaken,
          healingDone: totals.largeHealing,
          cardsPlayed: totals.largeCardsPlayed,
          assaults: totals.largeAttacks,
          averageDamagePerGame: round(totals.largeDamage / simulatedDenominator),
          averageHealingPerGame: round(totals.largeHealing / simulatedDenominator)
        }
      },
      events: totals.damageEvents
    },
    healing: totals.healEvents,
    energy: totals.energyEvents,
    cards: {
      totalCardsPlayedFromPlayerStatistics: totals.cardsPlayed,
      averageCardsPlayedPerGame: round(totals.cardsPlayed / simulatedDenominator),
      uses: totals.cardUses,
      moves: totals.cardMoves,
      equipmentUses: totals.equipmentUses,
      averageEquipmentUsesPerGame: round(totals.equipmentUses / simulatedDenominator),
      equipmentUsesByType: totals.equipmentByType
    },
    skills: totals.skillUses,
    generals: finalizePlayerAggregates(totals.generalStats),
    seats: finalizePlayerAggregates(totals.seatStats),
    diagnostics: {
      stalledGames: totals.stalled,
      failedGames: totals.failed,
      deathCleanupViolations: totals.deathCleanupViolations,
      stalledSamples: totals.stallSnapshots,
      errorSamples: totals.errorSamples,
      slowestGames
    },
    reserveSampling: {
      targetGames: config.games,
      candidateGames: config.candidateGames,
      reserveGames: config.reserveGames,
      acceptedGames: totals.durationsMs.length,
      abandonedCandidates: totals.reserveCandidatesAbandoned,
      abandonedCandidateIndexes: totals.reserveCandidateIndexes,
      candidateFailures: totals.reserveCandidateFailures,
      warning: config.reserveGames > 0
        ? "采用先完成先纳入样本；极慢对局可能被放弃，结果可能存在运行时长偏差。"
        : null
    },
    parallelism: {
      speculativeTasksStarted: totals.speculativeTasksStarted,
      speculativeWins: totals.speculativeWins,
      speculativeResultsDiscarded: totals.speculativeResultsDiscarded,
      speculativeErrorsIgnored: totals.speculativeErrorsIgnored,
      speculativeDiscardedComputeSeconds: round(totals.speculativeDiscardedComputeMs / 1000, 3),
      maxBusyWorkers: totals.maxBusyWorkers,
      maxSpeculativeWorkers: totals.maxSpeculativeWorkers
    },
    timing: {
      wallClockSeconds: round(elapsedMs / 1000, 3),
      gamesPerSecond: round(simulatedGames / Math.max(0.001, elapsedMs / 1000), 3),
      summedGameComputeSeconds: round(totals.durationsMs.reduce((sum, value) => sum + value, 0) / 1000, 3),
      perGameMs: durationStats,
      fastestGameMs: durationStats.minimum,
      medianGameMs: durationStats.median,
      p95GameMs: durationStats.p95,
      slowestGameMs: durationStats.maximum
    },
    ...(gameRecords ? { gameRecords } : {})
  };
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, milliseconds / 1000);
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${(seconds - minutes * 60).toFixed(0)} 秒`;
}

async function runPool(config) {
  const totals = createTotals();
  const queue = Array.from({ length: config.candidateGames }, (_, offset) => config.startIndex + offset);
  const attempts = new Map();
  const completedIndexes = new Set();
  const speculationBlockedIndexes = new Set();
  const activeByIndex = new Map();
  const firstStartedAtByIndex = new Map();
  const workers = new Set();
  const startedAt = performance.now();
  let acceptedGames = 0;
  let nextTaskId = 1;
  let finished = false;
  let finishResolve;
  let finishReject;
  let tailTimer = null;
  let lastProgressSettled = -1;
  let lastTailStatusAt = 0;

  const finishedPromise = new Promise((resolvePromise, rejectPromise) => {
    finishResolve = resolvePromise;
    finishReject = rejectPromise;
  });

  const busyWorkers = () => [...workers].filter((worker) => worker.__busy).length;
  const speculativeWorkers = () => [...workers].filter(
    (worker) => worker.__busy && worker.__task?.speculative
  ).length;
  const outstandingUniqueGames = () => (
    [...activeByIndex.keys()].filter((index) => !completedIndexes.has(index)).length
  );

  const updateConcurrencyPeaks = () => {
    totals.maxBusyWorkers = Math.max(totals.maxBusyWorkers, busyWorkers());
    totals.maxSpeculativeWorkers = Math.max(
      totals.maxSpeculativeWorkers,
      speculativeWorkers()
    );
  };

  const printProgress = (force = false) => {
    if (!config.progress) return;
    if (!force && acceptedGames % config.progressEvery !== 0) return;
    if (acceptedGames === lastProgressSettled) return;
    lastProgressSettled = acceptedGames;
    const elapsed = performance.now() - startedAt;
    const rate = acceptedGames / Math.max(0.001, elapsed / 1000);
    const remaining = config.games - acceptedGames;
    const eta = remaining / Math.max(0.001, rate) * 1000;
    process.stderr.write(
      `[balance] ${acceptedGames}/${config.games}，` +
      `速度 ${rate.toFixed(2)} 局/秒，预计剩余 ${formatDuration(eta)}\n`
    );
  };

  const printTailStatus = () => {
    if (!config.progress || !config.tailStatusMs || queue.length) return;
    if (acceptedGames >= config.games) return;
    const now = performance.now();
    if (now - lastTailStatusAt < config.tailStatusMs) return;
    lastTailStatusAt = now;
    const remaining = config.games - acceptedGames;
    const unique = outstandingUniqueGames();
    const busy = busyWorkers();
    const speculative = speculativeWorkers();
    process.stderr.write(
      `[balance] 尾部 ${acceptedGames}/${config.games}，还需 ${remaining} 个结果，` +
      `${busy}/${config.workers} 个 Worker 运行，待决候选局 ${unique} 个，` +
      `投机副本 ${speculative} 个。\n`
    );
  };

  const clearWorkerTimer = (worker) => {
    if (worker.__timer) clearTimeout(worker.__timer);
    worker.__timer = null;
  };

  const detachTask = (worker) => {
    clearWorkerTimer(worker);
    const task = worker.__task;
    if (!task) {
      worker.__busy = false;
      return null;
    }

    const activeWorkers = activeByIndex.get(task.index);
    if (activeWorkers) {
      activeWorkers.delete(worker);
      if (!activeWorkers.size) {
        activeByIndex.delete(task.index);
        firstStartedAtByIndex.delete(task.index);
      }
    }

    worker.__task = null;
    worker.__busy = false;
    return task;
  };

  const terminateAll = async () => {
    if (tailTimer) {
      clearInterval(tailTimer);
      tailTimer = null;
    }
    const terminations = [];
    for (const worker of workers) {
      worker.__expectedExit = true;
      clearWorkerTimer(worker);
      terminations.push(worker.terminate().catch(() => { }));
    }
    await Promise.allSettled(terminations);
    workers.clear();
  };

  const completeIfDone = async () => {
    if (finished) return;

    if (acceptedGames >= config.games) {
      const abandoned = new Set();
      for (const index of queue) {
        if (!completedIndexes.has(index)) abandoned.add(index);
      }
      for (const index of activeByIndex.keys()) {
        if (!completedIndexes.has(index)) abandoned.add(index);
      }
      totals.reserveCandidateIndexes = [...abandoned].sort((a, b) => a - b);
      totals.reserveCandidatesAbandoned = totals.reserveCandidateIndexes.length;

      finished = true;
      printProgress(true);
      await terminateAll();
      finishResolve({ totals, elapsedMs: performance.now() - startedAt });
      return;
    }

    if (!queue.length && activeByIndex.size === 0) {
      finished = true;
      await terminateAll();
      finishReject(new Error(
        `候选对局已耗尽：需要 ${config.games} 个有效结果，实际只有 ${acceptedGames} 个。`
      ));
    }
  };

  const recordPermanentFailure = async (index, error) => {
    if (completedIndexes.has(index)) return;
    completedIndexes.add(index);
    totals.failed += 1;
    totals.reserveCandidateFailures += 1;
    if (totals.errorSamples.length < config.errorSamplesLimit) {
      totals.errorSamples.push({ index, ...error });
    }
    printProgress();

    if (config.failFast && !finished) {
      finished = true;
      await terminateAll();
      finishReject(new Error(`第 ${index} 局失败：${error.message}`));
      return;
    }
    await completeIfDone();
  };

  const retryOrFail = async (index, error) => {
    if (completedIndexes.has(index)) return;
    const activeWorkers = activeByIndex.get(index);
    if (activeWorkers?.size) {
      totals.speculativeErrorsIgnored += 1;
      return;
    }

    const used = attempts.get(index) ?? 0;
    if (used < config.retries) {
      attempts.set(index, used + 1);
      queue.push(index);
      process.stderr.write(
        `[balance] 第 ${index} 局失败，准备重试 ${used + 1}/${config.retries}：${error.message}\n`
      );
      return;
    }
    await recordPermanentFailure(index, error);
  };

  const currentSpeculationDelayMs = () => {
    if (!totals.durationsMs.length) return config.tailSpeculationMinMs;
    const sorted = [...totals.durationsMs].sort((a, b) => a - b);
    const median = percentile(sorted, 0.5);
    return Math.max(
      config.tailSpeculationMinMs,
      median * config.tailSpeculationFactor
    );
  };

  const chooseSpeculativeIndex = () => {
    if (!config.tailSpeculation || config.reserveGames > 0 || queue.length) return null;
    const now = performance.now();
    const delayMs = currentSpeculationDelayMs();
    const copyCap = config.tailMaxCopies > 0
      ? config.tailMaxCopies
      : config.workers;

    const candidates = [];
    for (const [index, activeWorkers] of activeByIndex) {
      if (completedIndexes.has(index) || speculationBlockedIndexes.has(index)) continue;
      const firstStartedAt = firstStartedAtByIndex.get(index) ?? now;
      const ageMs = now - firstStartedAt;
      if (ageMs < delayMs || activeWorkers.size >= copyCap) continue;
      candidates.push({ index, copies: activeWorkers.size, ageMs });
    }

    candidates.sort((left, right) => (
      left.copies - right.copies || right.ageMs - left.ageMs || left.index - right.index
    ));
    return candidates[0]?.index ?? null;
  };

  const dispatchTask = (worker, index, speculative) => {
    if (finished || worker.__busy || completedIndexes.has(index)) return false;
    if (!speculative) speculationBlockedIndexes.delete(index);
    const task = {
      taskId: nextTaskId,
      index,
      speculative,
      assignedAt: performance.now()
    };
    nextTaskId += 1;

    worker.__busy = true;
    worker.__task = task;
    worker.__deathHandled = false;

    let activeWorkers = activeByIndex.get(index);
    if (!activeWorkers) {
      activeWorkers = new Set();
      activeByIndex.set(index, activeWorkers);
      firstStartedAtByIndex.set(index, task.assignedAt);
    }
    activeWorkers.add(worker);

    if (speculative) totals.speculativeTasksStarted += 1;
    updateConcurrencyPeaks();
    worker.postMessage({
      type: "run",
      index,
      taskId: task.taskId,
      speculative
    });
    return true;
  };

  const assign = (worker) => {
    if (finished || worker.__busy || worker.__deathHandled) return false;

    while (queue.length) {
      const index = queue.shift();
      if (completedIndexes.has(index)) continue;
      return dispatchTask(worker, index, false);
    }

    const speculativeIndex = chooseSpeculativeIndex();
    if (speculativeIndex !== null) {
      return dispatchTask(worker, speculativeIndex, true);
    }

    void completeIfDone();
    return false;
  };

  const assignIdleWorkers = () => {
    if (finished) return;
    for (const worker of workers) {
      if (!worker.__busy && !worker.__deathHandled) assign(worker);
    }
    updateConcurrencyPeaks();
    printTailStatus();
  };

  const ensureWorkerCount = () => {
    if (finished || acceptedGames >= config.games) return;
    while (workers.size < config.workers) spawnWorker();
  };

  const handleWorkerDeath = async (worker, error) => {
    if (worker.__deathHandled) return;
    worker.__deathHandled = true;
    const task = detachTask(worker);
    workers.delete(worker);

    if (task && !completedIndexes.has(task.index)) {
      speculationBlockedIndexes.add(task.index);
      await retryOrFail(task.index, serializeError(error));
    }

    ensureWorkerCount();
    assignIdleWorkers();
  };

  const armTimeout = (worker, taskId) => {
    if (!config.gameTimeoutMs) return;
    clearWorkerTimer(worker);
    worker.__timer = setTimeout(async () => {
      const task = worker.__task;
      if (finished || !task || task.taskId !== taskId) return;
      worker.__expectedExit = true;
      await handleWorkerDeath(
        worker,
        new Error(`超过单局超时限制 ${config.gameTimeoutMs} ms`)
      );
      await worker.terminate().catch(() => { });
    }, config.gameTimeoutMs);
  };

  function spawnWorker() {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: {
        role: "balance-worker",
        config: {
          seedBase: config.seedBase,
          searchNodeBudget: config.searchNodeBudget,
          maxRounds: config.maxRounds,
          detailed: config.detailed
        }
      }
    });

    worker.__busy = false;
    worker.__task = null;
    worker.__timer = null;
    worker.__deathHandled = false;
    worker.__expectedExit = false;
    workers.add(worker);

    worker.on("message", async (message) => {
      if (finished) return;

      if (message?.type === "ready") {
        assign(worker);
        return;
      }

      if (message?.type === "started") {
        if (worker.__task?.taskId === message.taskId) {
          armTimeout(worker, message.taskId);
        }
        return;
      }

      if (message?.type === "result") {
        const task = worker.__task;
        if (!task || task.taskId !== message.taskId || task.index !== message.index) return;
        detachTask(worker);

        if (completedIndexes.has(task.index)) {
          totals.speculativeResultsDiscarded += 1;
          totals.speculativeDiscardedComputeMs += message.result?.durationMs ?? 0;
          assign(worker);
          return;
        }

        completedIndexes.add(task.index);
        if (task.speculative) totals.speculativeWins += 1;
        mergeResult(totals, message.result, config);
        acceptedGames += 1;
        printProgress();
        await completeIfDone();
        assignIdleWorkers();
        return;
      }

      if (message?.type === "gameError") {
        const task = worker.__task;
        if (!task || task.taskId !== message.taskId || task.index !== message.index) return;
        detachTask(worker);

        if (completedIndexes.has(task.index)) {
          totals.speculativeErrorsIgnored += 1;
        } else {
          speculationBlockedIndexes.add(task.index);
          await retryOrFail(task.index, message.error);
        }
        assignIdleWorkers();
      }
    });

    worker.on("error", (error) => {
      void handleWorkerDeath(worker, error);
    });

    worker.on("exit", (code) => {
      if (worker.__expectedExit || finished) return;
      if (code !== 0 || worker.__task !== null) {
        void handleWorkerDeath(worker, new Error(`Worker 异常退出，退出码 ${code}`));
      } else {
        workers.delete(worker);
        ensureWorkerCount();
      }
    });
  }

  for (let index = 0; index < config.workers; index += 1) {
    spawnWorker();
  }

  tailTimer = setInterval(() => {
    assignIdleWorkers();
  }, config.tailCheckMs);

  return finishedPromise;
}

function printHelp() {
  console.log(`FiveRealms 正式多线程平衡测试器

用法：
  npm run test:balance -- [参数]
  node ./tests/balance.mjs [参数]

核心参数：
  -g, --games <n>                         最终纳入统计的有效对局数，默认 200
      --reserve-games <n>                 额外候选对局数；默认 10（准备 210 局，先完成 200 局即退出）
  -w, --workers <n|auto>                  Worker 数，默认 auto（使用全部可用线程）
      --reserve-cores <n>                  auto 模式保留逻辑核心数，默认 0
  -n, --search-node-budget <n>            每次 AI 规划节点预算，默认 1000
      --start-index <n>                    起始全局局号，默认 0
      --seed-base <n|0x...>               基础随机种子，默认 0x9e3779b9
      --max-rounds <n>                    单局最大轮数，默认 250
      --game-timeout-ms <n>               单局墙钟超时；0=关闭，默认 0
      --retries <n>                       单局异常重试次数，默认 0
      --fail-fast / --no-fail-fast        永久失败时立即停止，默认关闭

尾部并行：
      --tail-speculation / --no-tail-speculation
                                            尾部慢局投机副本；reserve-games>0 时默认关闭
      --tail-speculation-min-ms <n>        慢局至少运行多久才复制，默认 1000
      --tail-speculation-factor <n>        阈值=已完成局中位耗时×系数，默认 0.75
      --tail-max-copies <n>                同一局最大并行副本；0=自动填满，默认 0
      --tail-check-ms <n>                  尾部调度检查间隔，默认 200
      --tail-status-ms <n>                 尾部状态输出间隔；0=关闭，默认 2000

判定参数：
      --min-small-win-rate <n>             小队最低胜率，默认 40
      --max-small-win-rate <n>             小队最高胜率，默认 60
      --max-stalled-games <n>              允许停滞局数，默认 0
      --max-death-cleanup-violations <n>   允许死亡清理违规数，默认 0
      --report-only                        仅跳过胜率门槛；异常与停滞仍失败

报告参数：
      --detailed / --no-detailed           完整事件统计，默认开启
      --include-game-records               在 JSON 中加入逐局记录，默认关闭
      --game-records-limit <n>             逐局记录上限；0=全部，默认 0
      --slow-game-samples <n>              最慢对局样本数量，默认 10
      --stall-samples <n>                  停滞快照数量，默认 3
      --error-samples <n>                  错误样本数量，默认 5
      --summary / --no-summary             stderr 输出中文摘要，默认开启
      --stdout / --no-stdout               stdout 输出 JSON，默认开启
      --pretty / --no-pretty               JSON 美化缩进，默认开启
  -o, --output <path>                      同时把完整 JSON 写入文件

进度参数：
      --progress / --no-progress           显示进度，默认开启
      --progress-every <n>                 每完成多少局输出一次，默认 10
  -h, --help                               显示帮助

常用示例：
  npm run test:balance
  npm run test:balance -- --games 1000 --reserve-games 24 --workers 24 --search-node-budget 1500
  npm run test:balance -- --report-only --output reports/balance.json
  npm run test:balance -- --include-game-records --game-records-limit 0
  npm run test:balance -- --game-timeout-ms 120000 --retries 1

所有参数均有 FIVE_REALMS_* 环境变量版本；运行 --help 后可按参数名对应设置。`);
}

function printSummary(report) {
  const lines = [
    "",
    "[balance] ===== 测试摘要 =====",
    `[balance] 对局：${report.completedGames}/${report.games} 完成，停滞 ${report.stalledGames}，失败 ${report.failedGames}`,
    `[balance] 胜率：小队 ${report.smallTeamWinRate}%（${report.smallTeamWins} 胜），大队 ${report.largeTeamWinRate}%（${report.largeTeamWins} 胜）`,
    `[balance] 轮数：平均 ${report.gameFlow.rounds.average}，中位 ${report.gameFlow.rounds.median}，P95 ${report.gameFlow.rounds.p95}，最大 ${report.gameFlow.rounds.maximum}`,
    `[balance] 战斗：平均突袭 ${report.averageAssaults}，救援率 ${report.rescueRate}%，死亡 ${report.combat.totalDeaths}`,
    `[balance] 卡牌：共使用 ${report.cards.uses.total}，结算成功 ${report.cards.uses.resolved}，取消 ${report.cards.uses.cancelled}`,
    `[balance] 性能：${report.timing.wallClockSeconds} 秒，${report.timing.gamesPerSecond} 局/秒，中位单局 ${report.timing.medianGameMs} ms，P95 ${report.timing.p95GameMs} ms`,
    `[balance] 候选：准备 ${report.reserveSampling.candidateGames} 局，纳入 ${report.reserveSampling.acceptedGames} 局，放弃 ${report.reserveSampling.abandonedCandidates} 局`,
    `[balance] 并行：峰值 ${report.parallelism.maxBusyWorkers} Worker，投机任务 ${report.parallelism.speculativeTasksStarted}，投机获胜 ${report.parallelism.speculativeWins}`,
    "[balance] ====================",
    ""
  ];
  process.stderr.write(`${lines.join("\n")}\n`);
}

async function startMain() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    printHelp();
    return;
  }

  const config = buildConfig(cli);
  process.stderr.write(
    `[balance] 目标 ${config.games} 局，准备 ${config.candidateGames} 个不同候选局，` +
    `${config.workers}/${config.logicalCpuCount} 个 Worker，` +
    `每次搜索 ${config.searchNodeBudget} 节点，最大 ${config.maxRounds} 轮。\n`
  );

  const { totals, elapsedMs } = await runPool(config);
  const report = buildReport(config, totals, elapsedMs);
  const json = config.pretty
    ? `${JSON.stringify(report, null, 2)}\n`
    : `${JSON.stringify(report)}\n`;

  if (config.summary) printSummary(report);
  if (config.stdout) process.stdout.write(json);

  if (config.output) {
    const outputPath = resolve(process.cwd(), config.output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, json, "utf8");
    process.stderr.write(`[balance] 报告已写入 ${outputPath}\n`);
  }

  let failed = false;
  if (report.failedGames > 0) {
    console.error(`平衡测试失败：${report.failedGames} 局执行异常。`);
    failed = true;
  }
  if (report.stalledGames > config.maxStalledGames) {
    console.error(`平衡测试失败：${report.stalledGames} 局超过 ${config.maxRounds} 轮仍未结束，允许上限 ${config.maxStalledGames}。`);
    failed = true;
  }
  if (report.deathCleanupViolations > config.maxDeathCleanupViolations) {
    console.error(`平衡测试失败：死亡清理违规 ${report.deathCleanupViolations} 次，允许上限 ${config.maxDeathCleanupViolations}。`);
    failed = true;
  }
  if (!config.reportOnly && report.completedGames > 0 && (
    report.smallTeamWinRate < config.minSmallWinRate ||
    report.smallTeamWinRate > config.maxSmallWinRate
  )) {
    console.error(`平衡测试失败：小队胜率 ${report.smallTeamWinRate}% 超出目标 ${config.minSmallWinRate}%～${config.maxSmallWinRate}%。`);
    failed = true;
  }
  if (failed) process.exitCode = 1;
}

if (isMainThread) {
  await startMain();
} else if (workerData?.role === "balance-worker") {
  await startWorker();
}