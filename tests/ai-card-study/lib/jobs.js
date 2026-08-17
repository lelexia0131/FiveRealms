import {
  initGame,
  cloneGame,
  runGame,
  structuralFingerprint,
  classifyState,
  addExtraCardToHand,
  takeCardFromDeckToHand,
  drawOneToHand,
  discardCardFromHand,
  installForcedFirstAction,
  installBestOtherFirstAction,
  installWindowHooks,
  continueTurnFromAction,
  ForkSignal
} from "./harness.js";
import { ActionLegality } from "../../../js/application/action/ActionLegality.js";
import { CARD_DEFINITIONS } from "../../../js/domain/definitions/cards/CardDefinitions.js";
import { getStudyRandom } from "./studyRandom.js";
import { performance } from "node:perf_hooks";

export const ALL_CARD_IDS = Object.keys(CARD_DEFINITIONS);

const byId = (game, playerId) => game.state.players.find((entry) => entry.id === playerId) ?? null;

function resultOf(game, subject) {
  return {
    win: game.state.winnerTeam === subject.battleTeam ? 1 : 0,
    stalled: !game.state.winnerTeam,
    rounds: game.state.currentRound,
    turns: 0
  };
}

/**
 * 自然对局语料任务：记录每一回合开始的采样状态与最终结果。
 */
export async function runCorpusJob(job) {
  const { index, seed, roleOverride, nodeBudget, maxRounds } = job;
  const { game, rng } = await initGame({ seed, roleOverride, nodeBudget });
  const states = [];
  const startedAt = performance.now();
  const result = await runGame(game, {
    maxRounds,
    onTurnStart: async (g, player, turn) => {
      if (roleOverride && player.id !== g.state.players[0].id) return null;
      const classification = classifyState(g, player);
      states.push({
        seed,
        roleOverride,
        turn,
        round: g.state.currentRound,
        playerId: player.id,
        seat: player.seatIndex,
        characterId: player.characterId,
        battleTeam: player.battleTeam,
        classification,
        fingerprint: structuralFingerprint(g),
        finalWinner: null
      });
      return null;
    }
  });
  for (const state of states) state.finalWinner = result.winnerTeam;
  const durationMs = performance.now() - startedAt;
  game.dispose();
  return {
    index,
    seed,
    roleOverride,
    gameResult: { ...result, durationMs },
    states
  };
}

/**
 * 回放一个采样状态并运行指定指标的所有成对分支。
 * metric: "hold" | "acquire" | "use"
 * hold 同时产出 discard 行（与 hold 共享自然对照组）。
 */
export async function runStateJob(job) {
  const {
    stateId, seed, roleOverride, targetTurn, metric,
    nodeBudget, maxRounds, expectedFingerprint
  } = job;
  const { game, rng } = await initGame({ seed, roleOverride, nodeBudget });
  let found = false;
  await runGame(game, {
    maxRounds,
    onTurnStart: async (g, player, turn) => {
      if (turn === targetTurn) {
        found = true;
        return "stop";
      }
      return null;
    }
  });
  if (!found) {
    game.dispose();
    return { stateId, metric, kind: "error", message: "turn-not-found" };
  }
  const fp = structuralFingerprint(game);
  if (JSON.stringify(fp) !== JSON.stringify(expectedFingerprint)) {
    game.dispose();
    return { stateId, metric, kind: "error", message: "fingerprint-mismatch" };
  }

  const subject = game.currentPlayer;
  const classification = classifyState(game, subject);
  const base = {
    stateId,
    seed,
    sampleType: job.sampleType ?? "composite",
    role: subject.characterId,
    battleTeam: subject.battleTeam,
    round: game.state.currentRound,
    seat: subject.seatIndex,
    classification
  };
  const rngState = rng.snapshot();
  const studyRandom = getStudyRandom();
  const mathState = studyRandom ? studyRandom.snapshot() : null;
  const restoreMath = () => {
    if (mathState !== null && studyRandom) studyRandom.restore(mathState);
  };
  const rows = [];

  if (metric === "hold") {
    restoreMath();
    const control = cloneGame(game, rngState);
    const controlResult = await runGame(control, { maxRounds });
    control.dispose();
    const controlWin = controlResult.winnerTeam === subject.battleTeam ? 1 : 0;

    for (const cardId of ALL_CARD_IDS) {
      restoreMath();
      const arm = cloneGame(game, rngState);
      const armSubject = byId(arm, subject.id);
      addExtraCardToHand(arm, armSubject, cardId);
      const armResult = await runGame(arm, { maxRounds });
      arm.dispose();
      rows.push({
        ...base,
        metric: "hold",
        card: cardId,
        aWin: armResult.winnerTeam === subject.battleTeam ? 1 : 0,
        bWin: controlWin,
        aStalled: armResult.stalled,
        bStalled: controlResult.stalled,
        aRounds: armResult.rounds,
        bRounds: controlResult.rounds
      });
    }

    const held = new Set(subject.hand.map((card) => card.definitionId));
    for (const cardId of held) {
      restoreMath();
      const arm = cloneGame(game, rngState);
      const armSubject = byId(arm, subject.id);
      const card = armSubject.hand.find((entry) => entry.definitionId === cardId);
      await discardCardFromHand(arm, armSubject, card);
      const armResult = await runGame(arm, { maxRounds });
      arm.dispose();
      rows.push({
        ...base,
        metric: "discard",
        card: cardId,
        aWin: controlWin,
        bWin: armResult.winnerTeam === subject.battleTeam ? 1 : 0,
        aStalled: controlResult.stalled,
        bStalled: armResult.stalled,
        aRounds: controlResult.rounds,
        bRounds: armResult.rounds
      });
    }
  } else if (metric === "acquire") {
    restoreMath();
    const drawControl = cloneGame(game, rngState);
    const drawSubject = byId(drawControl, subject.id);
    const drawSuccess = await drawOneToHand(drawControl, drawSubject);
    if (!drawSuccess) {
      drawControl.dispose();
      game.dispose();
      return { stateId, metric, kind: "error", message: "draw-failed" };
    }
    const controlResult = await runGame(drawControl, { maxRounds });
    drawControl.dispose();
    const controlWin = controlResult.winnerTeam === subject.battleTeam ? 1 : 0;

    for (const cardId of ALL_CARD_IDS) {
      restoreMath();
      const arm = cloneGame(game, rngState);
      const armSubject = byId(arm, subject.id);
      const taken = takeCardFromDeckToHand(arm, armSubject, cardId);
      if (!taken) {
        arm.dispose();
        continue;
      }
      const armResult = await runGame(arm, { maxRounds });
      arm.dispose();
      rows.push({
        ...base,
        metric: "acquire",
        card: cardId,
        aWin: armResult.winnerTeam === subject.battleTeam ? 1 : 0,
        bWin: controlWin,
        aStalled: armResult.stalled,
        bStalled: controlResult.stalled,
        aRounds: armResult.rounds,
        bRounds: controlResult.rounds
      });
    }
  } else if (metric === "use") {
    for (const cardId of ALL_CARD_IDS) {
      restoreMath();
      const armA = cloneGame(game, rngState);
      const armASubject = byId(armA, subject.id);
      if (!armASubject.hand.some((card) => card.definitionId === cardId)) {
        addExtraCardToHand(armA, armASubject, cardId);
      }
      installForcedFirstAction(armA, cardId);
      const resultA = await runGame(armA, { maxRounds });
      const aLegal = Boolean(armA.__forcedLegal);
      const aPlayed = Boolean(armA.__forcedPlayed);
      armA.dispose();

      restoreMath();
      const armB = cloneGame(game, rngState);
      const armBSubject = byId(armB, subject.id);
      if (!armBSubject.hand.some((card) => card.definitionId === cardId)) {
        addExtraCardToHand(armB, armBSubject, cardId);
      }
      installBestOtherFirstAction(armB, cardId);
      const resultB = await runGame(armB, { maxRounds });
      armB.dispose();

      rows.push({
        ...base,
        metric: "use",
        card: cardId,
        aWin: resultA.winnerTeam === subject.battleTeam ? 1 : 0,
        bWin: resultB.winnerTeam === subject.battleTeam ? 1 : 0,
        aStalled: resultA.stalled,
        bStalled: resultB.stalled,
        aRounds: resultA.rounds,
        bRounds: resultB.rounds,
        aLegal,
        aPlayed
      });
    }
  }

  game.dispose();
  return { stateId, metric, kind: "ok", rows };
}

function requiredBlockCount(source, card, damageType) {
  const isAssault = card?.subtypes?.includes("assault") && ["normal", "area"].includes(damageType);
  return isAssault && source?.equipment?.definitionId === "battleDevice" ? 2 : 1;
}

function blockSpec(game, ctx) {
  const { source, card, targets } = ctx;
  let subject = null;
  let damageType = "normal";
  if (card?.definitionId === "assault") {
    subject = targets?.[0] ?? null;
  } else if (card?.definitionId === "shockwave") {
    damageType = "area";
    const enemies = game.state.players.filter((player) => player.alive && player.battleTeam !== source.battleTeam);
    subject = enemies[0] ?? null;
  } else {
    return null;
  }
  if (!subject?.alive || subject.battleTeam === source.battleTeam) return null;
  const required = requiredBlockCount(source, card, damageType);
  const have = subject.hand.filter((entry) => entry.definitionId === "block").length;
  if (have >= required) return null;
  return {
    type: ctx.type,
    source,
    card,
    targets,
    selection: ctx.selection,
    options: ctx.options,
    windowType: "block",
    subjectId: subject.id,
    addDefinition: "block",
    addCount: required - have
  };
}

function counterSpec(game, ctx) {
  const { source, card } = ctx;
  if (card?.category !== "tactic" || card.counterable === false) return null;
  const chain = card.counterScope === "target"
    ? (ctx.targets ?? []).filter((player) => player?.alive && player.battleTeam !== source.battleTeam)
    : game.seatOrderFrom(source, false).filter((player) => player.alive && player.id !== source.id);
  const subject = chain.find((player) => !player.hand.some((entry) => entry.definitionId === "counter"));
  if (!subject) return null;
  return {
    type: ctx.type,
    source,
    card,
    targets: ctx.targets,
    selection: ctx.selection,
    options: ctx.options,
    windowType: "counter",
    subjectId: subject.id,
    addDefinition: "counter",
    addCount: 1
  };
}

function dyingSpecFromAction(game, ctx) {
  const { source, card, targets } = ctx;
  let dyingTarget = null;
  let expectedDamage = 1;
  if (card?.definitionId === "assault") {
    dyingTarget = targets?.[0] ?? null;
    expectedDamage = 1 + (source?.statuses?.exposeWeakness?.stacks ?? 0);
  } else if (card?.definitionId === "shockwave") {
    const enemies = game.state.players.filter((player) => player.alive && player.battleTeam !== source.battleTeam);
    dyingTarget = enemies[0] ?? null;
  } else if (card?.definitionId === "duel") {
    dyingTarget = targets?.[0] ?? null;
  }
  if (!dyingTarget?.alive || dyingTarget.battleTeam === source.battleTeam) return null;
  if (dyingTarget.hp + dyingTarget.shield > expectedDamage) return null;
  const rescueOrder = [dyingTarget, ...game.seatOrderFrom(dyingTarget, false)
    .filter((player) => player.alive && player.battleTeam === dyingTarget.battleTeam)];
  const subject = rescueOrder.find((player) => !player.hand.some((entry) => entry.definitionId === "recover"));
  if (!subject) return null;
  return {
    type: ctx.type,
    source,
    card,
    targets,
    selection: ctx.selection,
    options: ctx.options,
    windowType: "dying",
    dyingTargetId: dyingTarget.id,
    subjectId: subject.id,
    addDefinition: "recover",
    addCount: 1
  };
}

function skillDyingSpec(game, ctx) {
  const { source, skillId, targets } = ctx;
  let dyingTarget = null;
  let expectedDamage = 1;
  if (skillId === "hunt") {
    dyingTarget = targets?.[0] ?? null;
    expectedDamage = 2;
  } else if (skillId === "burningField") {
    dyingTarget = game.state.players.find((player) => player.alive && player.battleTeam !== source.battleTeam) ?? null;
    expectedDamage = 1;
  }
  if (!dyingTarget?.alive || dyingTarget.battleTeam === source.battleTeam) return null;
  if (dyingTarget.hp + dyingTarget.shield > expectedDamage) return null;
  const rescueOrder = [dyingTarget, ...game.seatOrderFrom(dyingTarget, false)
    .filter((player) => player.alive && player.battleTeam === dyingTarget.battleTeam)];
  const subject = rescueOrder.find((player) => !player.hand.some((entry) => entry.definitionId === "recover"));
  if (!subject) return null;
  return {
    type: ctx.type,
    source,
    skillId,
    targets,
    windowType: "dying",
    dyingTargetId: dyingTarget.id,
    subjectId: subject.id,
    addDefinition: "recover",
    addCount: 1
  };
}

function huntBlockSpec(game, ctx) {
  const { source, targets } = ctx;
  const subject = targets?.[0] ?? null;
  if (!subject?.alive || subject.battleTeam === source.battleTeam) return null;
  const have = subject.hand.filter((entry) => entry.definitionId === "block").length;
  if (have >= 1) return null;
  return {
    type: ctx.type,
    source,
    skillId: "hunt",
    targets,
    windowType: "block",
    subjectId: subject.id,
    addDefinition: "block",
    addCount: 1
  };
}

export function buildWindowHooks(windowType) {
  return {
    playCard(game, ctx) {
      if (windowType === "block") return blockSpec(game, ctx);
      if (windowType === "counter") return counterSpec(game, ctx);
      if (windowType === "dying") return dyingSpecFromAction(game, ctx);
      return null;
    },
    useSkill(game, ctx) {
      if (windowType === "block" && ctx.skillId === "hunt") return huntBlockSpec(game, ctx);
      if (windowType === "dying") return skillDyingSpec(game, ctx);
      return null;
    }
  };
}

/**
 * 响应窗口任务：在首个合格动作入口分叉，A 臂给主体补上缺少的响应牌，B 臂对照。
 */
export async function runWindowJob(job) {
  const { seed, windowType, nodeBudget, maxRounds } = job;
  const { game, rng } = await initGame({ seed, nodeBudget });
  const hooks = buildWindowHooks(windowType);
  installWindowHooks(game, hooks);
  let forkSpec = null;
  try {
    await runGame(game, { maxRounds });
  } catch (error) {
    if (error instanceof ForkSignal) forkSpec = error.spec;
    else {
      game.dispose();
      return { seed, windowType, kind: "error", message: String(error?.stack ?? error) };
    }
  }
  if (!forkSpec) {
    game.dispose();
    return { jobId: job.jobId, seed, windowType, kind: "no-window" };
  }

  const rngState = rng.snapshot();
  const armA = cloneGame(game, rngState);
  const armB = cloneGame(game, rngState);
  const subjectA = byId(armA, forkSpec.subjectId);
  const subjectB = byId(armB, forkSpec.subjectId);
  for (let i = 0; i < forkSpec.addCount; i += 1) addExtraCardToHand(armA, subjectA, forkSpec.addDefinition);

  const counterA = installWindowCounters(armA, forkSpec);
  const counterB = installWindowCounters(armB, forkSpec);

  const specA = { ...forkSpec, source: byId(armA, forkSpec.source.id) };
  const specB = { ...forkSpec, source: byId(armB, forkSpec.source.id) };
  await continueTurnFromAction(armA, specA);
  await continueTurnFromAction(armB, specB);
  const resultA = await runGame(armA, { maxRounds });
  const resultB = await runGame(armB, { maxRounds });
  const classification = classifyState(game, game.state.players.find((player) => player.id === forkSpec.subjectId));
  const base = {
    seed,
    windowType,
    card: forkSpec.addDefinition,
    subjectRole: subjectA.characterId,
    battleTeam: subjectA.battleTeam,
    classification
  };
  const row = {
    ...base,
    aWin: resultA.winnerTeam === subjectA.battleTeam ? 1 : 0,
    bWin: resultB.winnerTeam === subjectB.battleTeam ? 1 : 0,
    aStalled: resultA.stalled,
    bStalled: resultB.stalled,
    windowOpenedA: counterA.windowOpened,
    windowOpenedB: counterB.windowOpened
  };
  armA.dispose();
  armB.dispose();
  game.dispose();
  return { jobId: job.jobId, seed, windowType, kind: "pair", row };
}

/**
 * 闪电状态反制窗口任务：在当前持有者回合开始前分叉。
 */
export async function runStatusCounterJob(job) {
  const { seed, nodeBudget, maxRounds } = job;
  const { game, rng } = await initGame({ seed, nodeBudget });
  let forkSpec = null;
  await runGame(game, {
    maxRounds,
    onTurnStart: async (g, player, turn) => {
      if (!ActionLegality.hasStatus(player, "lightning")) return null;
      const chain = [player, ...g.seatOrderFrom(player, false)].filter((entry) => entry.alive);
      const subject = chain.find((entry) => !entry.hand.some((card) => card.definitionId === "counter"));
      if (!subject) return null;
      forkSpec = {
        type: "turnStart",
        windowType: "statusCounter",
        subjectId: subject.id,
        addDefinition: "counter",
        addCount: 1
      };
      return "stop";
    }
  });
  if (!forkSpec) {
    game.dispose();
    return { jobId: job.jobId, seed, windowType: "statusCounter", kind: "no-window" };
  }
  const rngState = rng.snapshot();
  const armA = cloneGame(game, rngState);
  const armB = cloneGame(game, rngState);
  const subjectA = byId(armA, forkSpec.subjectId);
  const subjectB = byId(armB, forkSpec.subjectId);
  addExtraCardToHand(armA, subjectA, "counter");
  const counterA = installWindowCounters(armA, forkSpec);
  const counterB = installWindowCounters(armB, forkSpec);
  const resultA = await runGame(armA, { maxRounds });
  const resultB = await runGame(armB, { maxRounds });
  const classification = classifyState(game, game.state.players.find((player) => player.id === forkSpec.subjectId));
  const row = {
    seed,
    windowType: "statusCounter",
    card: "counter",
    subjectRole: subjectA.characterId,
    battleTeam: subjectA.battleTeam,
    classification,
    aWin: resultA.winnerTeam === subjectA.battleTeam ? 1 : 0,
    bWin: resultB.winnerTeam === subjectB.battleTeam ? 1 : 0,
    aStalled: resultA.stalled,
    bStalled: resultB.stalled,
    windowOpenedA: counterA.windowOpened,
    windowOpenedB: counterB.windowOpened
  };
  armA.dispose();
  armB.dispose();
  game.dispose();
  return { jobId: job.jobId, seed, windowType: "statusCounter", kind: "pair", row };
}

/** 统一窗口任务入口：根据 windowType 分发。 */
export async function runWindowJobDispatch(job) {
  if (job.windowType === "statusCounter") return runStatusCounterJob(job);
  return runWindowJob(job);
}

function installWindowCounters(game, spec) {
  const counters = { windowOpened: 0 };
  const originalRequest = game.responseWorkflow.requestCardResponse.bind(game.responseWorkflow);
  game.responseWorkflow.requestCardResponse = async (responder, type, context, requiredCount = 1) => {
    const wanted = spec.windowType === "block" ? "block"
      : spec.windowType === "counter" || spec.windowType === "statusCounter" ? "counter"
        : null;
    if (responder?.id === spec.subjectId && wanted && type === wanted) counters.windowOpened += 1;
    return originalRequest(responder, type, context, requiredCount);
  };
  if (spec.windowType === "dying") {
    const originalDyingRescue = game.responseWorkflow.requestDyingRescue.bind(game.responseWorkflow);
    game.responseWorkflow.requestDyingRescue = async (rescuer, target, card) => {
      if (rescuer?.id === spec.subjectId) counters.windowOpened += 1;
      return originalDyingRescue(rescuer, target, card);
    };
  }
  return counters;
}
