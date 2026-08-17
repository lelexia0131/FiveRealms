/*
模块职责
定义 Application 的 minimal Presentation boundary：玩家可见日志、伤害/治疗/护盾反馈、濒死与判定 overlay、延迟状态当前卡、闪电命中语义与 render 刷新；不吞并 Choice 或 Audio。

上游
application/combat、application/judgment 与 composition root。

下游
concrete UI/presentation adapter（当前由 Game composition 桥接）。

状态边界
只接收 data-only semantic DTO；不读写真 GameState。

信息边界
不得要求 Card/Player 实体；只允许公开字段与 ID。

架构约束
不得依赖 UIManager、DOM、Game runtime、Domain transitions、EventDispatcher 或 concrete adapters。
*/

const REQUIRED_METHODS = [
  "log",
  "showDamageFeedback",
  "showShieldFeedback",
  "showHealFeedback",
  "showDying",
  "hideDying",
  "showJudgment",
  "hideJudgment",
  "showCurrentEffect",
  "showLightningHit",
  "showCurrentAction",
  "playActionCue",
  "setPrompt",
  "showThinking",
  "clearThinking",
  "isThinkingActive",
  "showGameOver",
  "showPrivateReveal",
  "showDuel",
  "hideDuel",
  "refresh"
];

/*
功能
验证并冻结一个 PresentationPort implementation。

调用方
Game composition root 与 tests。

输入
含全部 FR-ARCH-8 evidence 方法的 implementation。

输出
冻结 PresentationPort。

读取状态
无。

写入状态
无。

调用函数
Object.freeze。

边界与不变量
只要求当前 Combat/Dying/Judgment/Status 与 FR-ARCH-9 Match/Turn/Action 真实消费的语义 surface；不创建 UIManager 副本。
*/
export function createPresentationPort(implementation) {
  if (!implementation) throw new TypeError("PresentationPort 需要 implementation");
  for (const method of REQUIRED_METHODS) {
    if (typeof implementation[method] !== "function") {
      throw new TypeError(`PresentationPort 缺少 ${method}()`);
    }
  }
  return Object.freeze({
    log: implementation.log,
    showDamageFeedback: implementation.showDamageFeedback,
    showShieldFeedback: implementation.showShieldFeedback,
    showHealFeedback: implementation.showHealFeedback,
    showDying: implementation.showDying,
    hideDying: implementation.hideDying,
    showJudgment: implementation.showJudgment,
    hideJudgment: implementation.hideJudgment,
    showCurrentEffect: implementation.showCurrentEffect,
    showLightningHit: implementation.showLightningHit,
    showCurrentAction: implementation.showCurrentAction,
    playActionCue: implementation.playActionCue,
    setPrompt: implementation.setPrompt,
    showThinking: implementation.showThinking,
    clearThinking: implementation.clearThinking,
    isThinkingActive: implementation.isThinkingActive,
    showGameOver: implementation.showGameOver,
    showPrivateReveal: implementation.showPrivateReveal,
    showDuel: implementation.showDuel,
    hideDuel: implementation.hideDuel,
    refresh: implementation.refresh
  });
}
