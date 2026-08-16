/*
模块职责
唯一拥有 Application Combat 的 damage、heal 与 HP-loss sequencing：防御判定、格挡响应、事件修正、Domain 计算、Transition commit、telemetry、presentation、dying 入口。

上游
core/Game legacy façade 与 future card/skill application consumers。

下游
Domain CombatRules、Domain ResourceTransitions、Application Response、Application Dying、PresentationPort 与 DiagnosticsPort。

状态边界
不直接写 hp/shield/statistics/aiMemory；全部 commit 经 Domain transitions 或注入 port/collaborator。

信息边界
不读取 concrete UI/AI/DOM；只读取 workflow 需要的公开角色事实。

架构约束
不得依赖 Game、UIManager、AIController、SoundManager、EventBus、SearchState、Planner 或 concrete adapters。
*/
import { calculateDamageResult, calculateHealAmount, isDying } from "../../domain/rules/combat/CombatRules.js?build=20260815-shadow-agent-p1-slot";
import { changeHp, changeShield } from "../../domain/state/transitions/ResourceTransitions.js?build=20260815-shadow-agent-p1-slot";

const REQUIRED_DEPENDENCIES = [
  "getState",
  "isSessionValid",
  "askForBlock",
  "judgeDefense",
  "enterDying",
  "emitEvent",
  "createId",
  "presentation",
  "diagnostics",
  "observeDamage"
];

/*
功能
创建 Application Combat Workflow。

调用方
core/Game composition root。

输入
显式注入的 state/session/response/judgment/dying/event/presentation/diagnostics/AI-observation collaborators。

输出
冻结 { damage, heal, loseHp }。

读取状态
无。

写入状态
内部无状态；写入经 dependencies。

调用函数
calculateDamageResult、calculateHealAmount、isDying、changeShield、changeHp。

边界与不变量
不持有 Game 引用；await 后保留原 session 检查点；damage/heal/loseHp 返回旧数值契约。
*/
export function createCombatWorkflow(dependencies) {
  for (const name of REQUIRED_DEPENDENCIES) {
    if (!dependencies?.[name]) throw new TypeError(`CombatWorkflow 缺少 ${name} collaborator`);
  }
  const runtime = dependencies;
  if (typeof runtime.getState !== "function" || typeof runtime.isSessionValid !== "function"
    || typeof runtime.askForBlock !== "function" || typeof runtime.judgeDefense !== "function"
    || typeof runtime.enterDying !== "function" || typeof runtime.emitEvent !== "function"
    || typeof runtime.createId !== "function") {
    throw new TypeError("CombatWorkflow 存在类型不正确的 collaborator");
  }

  /*
  功能
  执行伤害 workflow：雷达判定、格挡、beforeDamage、护盾/生命 commit、telemetry、afterDamage 与濒死入口。

  调用方
  Game.damage legacy façade。

  输入
  source、target、amount 与 context。

  输出
  Promise<实际生命伤害量>。

  读取状态
  Game state facts、response/judgment/dying collaborators。

  写入状态
  shield/hp 经 ResourceTransitions；telemetry 经 DiagnosticsPort/AI observation collaborator。

  调用函数
  judgeDefense、askForBlock、emitEvent、calculateDamageResult、changeShield、changeHp、diagnostics.recordDamage、observeDamage、enterDying。

  边界与不变量
  雷达与格挡路径不触发 beforeDamage；block 路径保持 context.blockedByCard；每次 await 后 session 检查点不减少。
  */
  async function damage(source, target, amount, context = {}) {
    const state = runtime.getState();
    const gameId = state.gameId;
    if (!runtime.isSessionValid(gameId) || !target?.alive || state.isGameOver) return 0;
    const metadata = {};
    if (context.metadata && typeof context.metadata === "object") Object.assign(metadata, context.metadata);
    const event = {
      type: "beforeDamage", source, target, amount: Math.max(0, amount), card: context.card ?? null,
      skill: context.skill ?? null, damageType: context.damageType ?? "normal", canBlock: context.canBlock ?? false,
      actionName: context.card?.name ?? context.actionName ?? context.reason ?? "伤害",
      delayedStatusContext: context.delayedStatusContext ?? null,
      cancelled: false, metadata, resolutionId: context.resolutionId ?? runtime.createId("skill-resolution")
    };
    if (event.amount > 0 && event.canBlock) {
      const judgment = await runtime.judgeDefense(source, target, event);
      if (!runtime.isSessionValid(gameId) || judgment.cancelled) return 0;
      if (judgment.immune || !target.alive || state.isGameOver) {
        await runtime.emitEvent("afterDamage", { ...event, type: "afterDamage", actualAmount: 0, shieldAbsorbed: 0, preventedBy: "defenseDevice" });
        return 0;
      }
    }
    const blockResult = await runtime.askForBlock(source, target, event);
    if (!runtime.isSessionValid(gameId) || blockResult.status === "cancelled") return 0;
    if (blockResult.status === "used") {
      context.blockedByCard = true;
      await runtime.emitEvent("afterDamage", { ...event, type: "afterDamage", actualAmount: 0, shieldAbsorbed: 0, preventedBy: "block" });
      if (!runtime.isSessionValid(gameId)) return 0;
      runtime.presentation.refresh();
      return 0;
    }
    await runtime.emitEvent("beforeDamage", event);
    if (!runtime.isSessionValid(gameId)) return 0;
    if (event.cancelled || !target.alive) return 0;
    if (event.amount <= 0) {
      runtime.presentation.log(`${target.name}没有受到生命伤害。`);
      await runtime.emitEvent("afterDamage", {
        ...event, type: "afterDamage", actualAmount: 0, shieldAbsorbed: 0, preventedBy: "damageReduction"
      });
      if (!runtime.isSessionValid(gameId)) return 0;
      runtime.presentation.refresh();
      return 0;
    }
    const damageResult = calculateDamageResult(event.amount, target.shield, target.hp);
    changeShield(state, target, -damageResult.shieldAbsorbed);
    const hpDamage = damageResult.hpDamage;
    changeHp(state, target, -hpDamage);
    runtime.diagnostics.recordDamage({ targetId: target.id, sourceId: source?.id ?? null, hpDamage });
    runtime.observeDamage(target, source, hpDamage);
    if (damageResult.shieldAbsorbed) {
      runtime.presentation.log(`${target.name}的护盾吸收了${damageResult.shieldAbsorbed}点伤害。`);
      runtime.presentation.showShieldFeedback(target.id, damageResult.shieldAbsorbed);
    }
    if (hpDamage) {
      runtime.presentation.log(`${target.name}受到${hpDamage}点伤害，剩余${target.hp}点生命。`, "damage");
      runtime.presentation.showDamageFeedback(target.id, hpDamage);
    } else {
      runtime.presentation.log(`${target.name}没有受到生命伤害。`);
    }
    await runtime.emitEvent("afterDamage", { ...event, type: "afterDamage", actualAmount: hpDamage, shieldAbsorbed: damageResult.shieldAbsorbed });
    if (!runtime.isSessionValid(gameId)) return hpDamage;
    if (isDying(target.hp, target.alive)) await runtime.enterDying(target, source, context);
    if (!runtime.isSessionValid(gameId)) return hpDamage;
    runtime.presentation.refresh();
    return hpDamage;
  }

  /*
  功能
  执行治疗 workflow：beforeHeal 事件修正、Domain 上限计算、生命 commit、telemetry、日志、afterHeal 与 render。

  调用方
  Game.heal legacy façade 与 DyingWorkflow。

  输入
  source、target、amount 与 context。

  输出
  Promise<实际治疗量>。

  读取状态
  Game state facts 与 event collaborators。

  写入状态
  hp 经 ResourceTransition；healing telemetry 经 DiagnosticsPort。

  调用函数
  emitEvent、calculateHealAmount、changeHp、diagnostics.recordHealing。

  边界与不变量
  beforeHeal 可修改 amount/cancel；actualAmount 为 0 时旧日志与 feedback 行为不变。
  */
  async function heal(source, target, amount, context = {}) {
    const state = runtime.getState();
    const gameId = state.gameId;
    if (!runtime.isSessionValid(gameId) || !target?.alive || target.hp >= target.maxHp || state.isGameOver) return 0;
    const event = { type: "beforeHeal", source, target, amount: Math.max(0, amount), card: context.card ?? null, skill: context.skill ?? null,
      reason: context.reason ?? "治疗", isDyingRescue: Boolean(context.isDyingRescue), cancelled: false, metadata: {} };
    await runtime.emitEvent("beforeHeal", event);
    if (!runtime.isSessionValid(gameId)) return 0;
    if (event.cancelled) return 0;
    const actualAmount = calculateHealAmount(event.amount, target.maxHp, target.hp);
    changeHp(state, target, actualAmount);
    runtime.diagnostics.recordHealing({ sourceId: source?.id ?? null, actualAmount });
    if (actualAmount) {
      if (!context.silentLog) runtime.presentation.log(`${target.name}恢复${actualAmount}点生命。`, "heal");
      if (typeof context.resultLog === "function") runtime.presentation.log(context.resultLog(actualAmount), "heal");
      else if (context.resultLog) runtime.presentation.log(String(context.resultLog), "heal");
      runtime.presentation.showHealFeedback(target.id, actualAmount);
    }
    await runtime.emitEvent("afterHeal", { ...event, type: "afterHeal", actualAmount });
    if (!runtime.isSessionValid(gameId)) return actualAmount;
    runtime.presentation.refresh();
    return actualAmount;
  }

  /*
  功能
  执行 HP-loss workflow：beforeHpLoss 事件修正、绕过护盾/格挡/雷达的生命 commit、telemetry、afterHpLoss 与濒死入口。

  调用方
  HpLossSystem legacy façade。

  输入
  player、amount 与 context。

  输出
  Promise<实际失去生命量>。

  读取状态
  Game state facts、event 与 dying collaborators。

  写入状态
  hp 经 ResourceTransition；damageTaken telemetry 经 DiagnosticsPort。

  调用函数
  emitEvent、changeHp、diagnostics.recordHpLoss、isDying、enterDying。

  边界与不变量
  保持独立于 damage；不合并为 ignoreShield 伤害；beforeHpLoss cancel/amount 修正语义不变。
  */
  async function loseHp(player, amount, context = {}) {
    const state = runtime.getState();
    const gameId = state.gameId;
    if (!runtime.isSessionValid(gameId) || !player?.alive || state.isGameOver || amount <= 0) return 0;
    const event = { type: "beforeHpLoss", player, amount: Math.max(0, amount), reason: context.reason ?? "效果", source: context.source ?? null, card: context.card ?? null, cancelled: false };
    await runtime.emitEvent("beforeHpLoss", event);
    if (!runtime.isSessionValid(gameId)) return 0;
    if (event.cancelled || event.amount <= 0) return 0;
    changeHp(state, player, -event.amount);
    runtime.diagnostics.recordHpLoss({ targetId: player.id, amount: event.amount });
    runtime.presentation.log(`${player.name}因${event.reason}失去${event.amount}点生命，当前生命${player.hp}。`, "damage");
    runtime.presentation.showDamageFeedback(player.id, event.amount);
    await runtime.emitEvent("afterHpLoss", { ...event, type: "afterHpLoss", actualAmount: event.amount });
    if (!runtime.isSessionValid(gameId)) return event.amount;
    if (isDying(player.hp, player.alive)) await runtime.enterDying(player, event.source, context);
    if (!runtime.isSessionValid(gameId)) return event.amount;
    runtime.presentation.refresh();
    return event.amount;
  }

  return Object.freeze({ damage, heal, loseHp });
}
