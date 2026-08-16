/*
模块职责
拥有「回收站」card trigger registration：cardUsed 事件接收、Domain predicate query、usage commit、draw orchestration 与 presentation；不拥有完整 Trigger engine。

上游
Game temporary composition root。

下游
Domain RecycleDeviceRules、RuleUsageTransitions 与 narrow draw/log collaborators。

状态边界
usage 经 RuleUsageTransition；不写其它 Domain state。

信息边界
不读取 UI/AI/DOM 或 hidden hand。

架构约束
不得依赖 Game、UIManager、AIController、SoundManager、EventBus runtime 或 concrete adapters。
*/
import { canTriggerRecycleDevice } from "../../domain/rules/card/RecycleDeviceRules.js?build=20260815-shadow-agent-p1-slot";
import { setRecycleDeviceUses } from "../../domain/state/transitions/RuleUsageTransitions.js?build=20260815-shadow-agent-p1-slot";

const REQUIRED_DEPENDENCIES = ["onEvent", "getState", "isSessionValid", "presentation", "drawCards"];

/*
功能
创建回收站 trigger registry。

调用方
Game temporary composition root。

输入
显式注入的 event/session/draw/log collaborators。

输出
冻结 { register }。

读取状态
无。

写入状态
经 listener 与 transition。

调用函数
canTriggerRecycleDevice、setRecycleDeviceUses。

边界与不变量
不迁移 EventBus；每次事件先 query pure predicate。
*/
export function createRecycleDeviceTrigger(dependencies) {
  for (const name of REQUIRED_DEPENDENCIES) {
    if (!dependencies?.[name]) throw new TypeError(`RecycleDeviceTrigger 缺少 ${name} collaborator`);
  }
  const runtime = dependencies;

  /*
  功能
  注册 cardUsed 回收站监听器。

  调用方
  Game.registerGlobalRules legacy bridge。

  输入
  无。

  输出
  无。

  读取状态
  无。

  写入状态
  listener registration。

  调用函数
  onEvent。

  边界与不变量
  key 固定为 global:recycleDevice。
  */
  function register() {
    runtime.onEvent("cardUsed", "global:recycleDevice", async (event) => {
      const owner = event.source;
      const state = runtime.getState();
      const gameId = state.gameId;
      const current = state.players[state.currentPlayerIndex] ?? null;
      const facts = {
        ownerAlive: owner.alive,
        currentActorId: current?.id ?? null,
        ownerId: owner.id,
        equipmentDefinitionId: owner.equipment?.definitionId ?? null,
        cardCategory: event.card.category,
        cardUsageMode: event.card.usageMode,
        useCount: owner.turnFlags.recycleDeviceUses ?? 0
      };
      if (!canTriggerRecycleDevice(facts)) return;
      setRecycleDeviceUses(state, owner, facts.useCount + 1);
      const drawn = await runtime.drawCards(owner, 1, "回收站", { silent: true });
      if (!runtime.isSessionValid(gameId)) return;
      runtime.presentation.log(`${owner.name}的「回收站」触发（${owner.turnFlags.recycleDeviceUses}/2），${drawn ? `摸${drawn}张牌` : "但未摸到牌"}。`);
    });
  }

  return Object.freeze({ register });
}
