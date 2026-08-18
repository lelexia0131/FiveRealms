/*
模块职责
唯一拥有与 Combat/Judgment 耦合的 delayed-status resolution workflow：sealed 与 lightning 的反制窗口、判定、移除/转移、skip 提交、伤害编排与语义 presentation。

上游
composition trigger bridge 与 tests。

下游
Domain StatusRules、Domain transitions、Application Response status-counter、Application Judgment 与 Application Combat damage。

状态边界
不直接写 statuses/phase/flags；commit 经 StatusTransitions/RuleUsageTransitions；presentation 经 PresentationPort。

信息边界
不读取 concrete UI/AI/DOM；下一闪电接收者由 Domain Status Rule 决定。

架构约束
不得依赖 MatchApplication、UIManager、AiController、SoundManager、EventDispatcher runtime、混合配置模块或 concrete adapters。
*/
import { nextLightningReceiverId } from "../../domain/rules/status/StatusRules.js";
import { createRuleStateView } from "../../domain/state/queries/RuleStateView.js";
import { setSkipActionPhase } from "../../domain/state/transitions/RuleUsageTransitions.js";
import { removeStatus, setStatus } from "../../domain/state/transitions/StatusTransitions.js";
import { RESPONSE_STATUS, isCancelledResponse } from "../response/ResponseResult.js";

const REQUIRED_DEPENDENCIES = [
  "getState",
  "isSessionValid",
  "askForStatusCounter",
  "judgeSeal",
  "judgeLightning",
  "damage",
  "presentation"
];

/*
功能
创建 delayed-status Application Workflow。

调用方
composition root。

输入
显式注入的 state/session/response/judgment/damage/presentation collaborators。

输出
冻结 { resolveSeal, resolveLightning }。

读取状态
无。

写入状态
内部无状态；Domain statuses/flags 经 transitions。

调用函数
nextLightningReceiverId、createRuleStateView、removeStatus、setStatus、setSkipActionPhase。

边界与不变量
不迁移 trigger engine；保持反制、判定、移除/转移、伤害与 presentation 的旧顺序。
*/
export function createStatusResolutionWorkflow(dependencies) {
  for (const name of REQUIRED_DEPENDENCIES) {
    if (!dependencies?.[name]) throw new TypeError(`StatusResolutionWorkflow 缺少 ${name} collaborator`);
  }
  const runtime = dependencies;

  /*
  功能
  把 Domain 下一闪电接收者 ID 解析为真实 Player。

  调用方
  resolveLightning。

  输入
  state 与当前 holder。

  输出
  receiver Player 或 null。

  读取状态
  state.players 与 status projections。

  写入状态
  无。

  调用函数
  createRuleStateView、nextLightningReceiverId。

  边界与不变量
  不重复 Domain 座位公式；未找到他人时返回当前 holder，保持旧 receiver 分支语义。
  */
  function nextLightningReceiver(state, holder) {
    const view = createRuleStateView(state);
    const receiverId = nextLightningReceiverId(view.players(), holder.id);
    return state.players.find((player) => player.id === receiverId) ?? null;
  }

  /*
  功能
  执行封印延迟状态结算。

  调用方
  beforeStatusResolve trigger bridge。

  输入
  holder 与 sealed status。

  输出
  无。

  读取状态
  holder status/session/game-over。

  写入状态
  sealed 移除与 skipActionPhase 经 transitions。

  调用函数
  askForStatusCounter、judgeSeal、removeStatus、setSkipActionPhase。

  边界与不变量
  战术判定为未生效；基础/装备判定提交 skip；counter 移除与 presentation 顺序不变。
  */
  async function resolveSeal(holder, status) {
    const state = runtime.getState();
    const gameId = state.gameId;
    if (!runtime.isSessionValid(gameId) || !holder?.alive || state.isGameOver) return;
    runtime.presentation.showCurrentEffect({ statusId: "seal", label: "即将判定", holderName: holder.name });
    runtime.presentation.log(`${holder.name}的「封印」即将判定，进入反制窗口。`, "important");
    const counterResult = await runtime.askForStatusCounter(holder, {
      statusId: "sealed",
      statusName: "封印",
      counterOutcome: "cancel",
      originPlayerId: status.originPlayerId ?? null
    });
    if (!runtime.isSessionValid(gameId) || state.isGameOver || !holder.alive) return;
    if (isCancelledResponse(counterResult)) return;
    if (counterResult.status === RESPONSE_STATUS.USED) {
      removeStatus(state, holder, "sealed");
      runtime.presentation.showCurrentEffect({ statusId: "seal", label: "被反制", holderName: holder.name });
      runtime.presentation.log(`${holder.name}的「封印」被反制，本次封印解除。`, "important");
      runtime.presentation.refresh();
      return;
    }
    const judgment = await runtime.judgeSeal(holder, { status });
    if (!runtime.isSessionValid(gameId) || state.isGameOver || !holder.alive || !judgment.handled) return;
    removeStatus(state, holder, "sealed");
    if (judgment.triggered) {
      runtime.presentation.showCurrentEffect({ statusId: "seal", label: "未生效", holderName: holder.name });
      runtime.presentation.log(`${holder.name}的「封印」判定牌为「${judgment.card.name}」（战术牌），「封印」未生效，本回合正常进行。`, "important");
    } else {
      setSkipActionPhase(state, holder, true);
      runtime.presentation.showCurrentEffect({ statusId: "seal", label: "生效", holderName: holder.name });
      const categoryLabel = judgment.category === "basic" ? "基础牌" : "装备牌";
      runtime.presentation.log(`${holder.name}的「封印」判定牌为「${judgment.card.name}」（${categoryLabel}），「封印」生效。`, "important");
    }
    runtime.presentation.refresh();
  }

  /*
  功能
  执行闪电延迟状态结算。

  调用方
  beforeStatusResolve trigger bridge。

  输入
  holder 与 lightning status。

  输出
  无。

  读取状态
  holder status/session/game-over 与 Domain seat facts。

  写入状态
  lightning 移除/设置经 transitions；伤害经 Application Combat。

  调用函数
  askForStatusCounter、judgeLightning、removeStatus、setStatus、nextLightningReceiver、damage。

  边界与不变量
  命中只移除不转移且 canBlock false；失败/反制转移保留 originPlayerId 元数据；VFX/SFX 只在实际命中触发。
  */
  async function resolveLightning(holder, status) {
    const state = runtime.getState();
    const gameId = state.gameId;
    if (!runtime.isSessionValid(gameId) || !holder?.alive || state.isGameOver) return;
    runtime.presentation.showCurrentEffect({ statusId: "lightning", label: "即将判定", holderName: holder.name });
    runtime.presentation.log(`${holder.name}的「闪电」即将判定，进入反制窗口。`, "important");
    const counterResult = await runtime.askForStatusCounter(holder, {
      statusId: "lightning",
      statusName: "闪电",
      counterOutcome: "transfer",
      originPlayerId: status.originPlayerId ?? null
    });
    if (!runtime.isSessionValid(gameId) || state.isGameOver || !holder.alive) return;
    if (isCancelledResponse(counterResult)) return;
    if (counterResult.status === RESPONSE_STATUS.USED) {
      removeStatus(state, holder, "lightning");
      const receiver = nextLightningReceiver(state, holder);
      if (receiver) {
        setStatus(state, receiver, "lightning", { ...status, cardDefinitionId: "lightning", originPlayerId: status.originPlayerId ?? holder.id });
        runtime.presentation.showCurrentEffect({ statusId: "lightning", label: "被反制", holderName: holder.name });
        runtime.presentation.log(`${holder.name}的「闪电」被反制，转移给${receiver.name}。`, "important");
      }
      runtime.presentation.refresh();
      return;
    }
    const judgment = await runtime.judgeLightning(holder, { status });
    if (!runtime.isSessionValid(gameId) || state.isGameOver || !holder.alive || !judgment.handled) return;
    if (judgment.triggered) {
      removeStatus(state, holder, "lightning");
      runtime.presentation.showCurrentEffect({ statusId: "lightning", label: "判定成功", holderName: holder.name });
      runtime.presentation.showLightningHit(holder.id);
      await runtime.damage(null, holder, 3, {
        damageType: "lightning",
        reason: "lightning",
        canBlock: false,
        actionName: "闪电",
        delayedStatusContext: {
          ownerId: holder.id,
          ownerName: holder.name,
          ownerBattleTeam: holder.battleTeam,
          statusId: "lightning",
          statusName: "闪电",
          event: "judgmentSuccess"
        },
        metadata: {
          statusId: "lightning",
          cardDefinitionId: "lightning",
          originPlayerId: status.originPlayerId ?? null,
          currentHolderId: holder.id,
          baseDamage: 3,
          judgmentCategory: "equipment"
        }
      });
      return;
    }
    removeStatus(state, holder, "lightning");
    const receiver = nextLightningReceiver(state, holder);
    if (receiver) {
      setStatus(state, receiver, "lightning", { ...status, cardDefinitionId: "lightning", originPlayerId: status.originPlayerId ?? holder.id });
      runtime.presentation.showCurrentEffect({ statusId: "lightning", label: "判定未生效", holderName: holder.name });
      runtime.presentation.log(`${holder.name}的「闪电」判定未生效，转移给${receiver.name}。`, "important");
    }
    runtime.presentation.refresh();
  }

  return Object.freeze({ resolveSeal, resolveLightning });
}
