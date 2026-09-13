import assert from "node:assert/strict";
import { runSearchRequest } from "../js/adapters/ai/worker/WorkerSearchRuntime.js";
import { createSearchWorkerClient } from "../js/adapters/ai/worker/SearchWorkerClient.js";
import { createAiChoiceAdapter } from "../js/adapters/ai/AiChoiceAdapter.js";
import { createResponseChoiceRequest } from "../js/application/choice/ResponseChoiceRequest.js";
import { Simulator } from "../js/ai/Simulator/Simulator.js";
import { Evaluator } from "../js/ai/Evaluator/Evaluator.js";

/*
功能
验证完整 Response 的预算隔离、概率中断和最终结果提交边界。

调用方
AI 响应定向测试。

输入
canonical Game fixture helpers。

输出
Promise<void>；合同违反时断言失败。

读取状态
固定 Counter 响应与真实 Simulator/Probability 方法。

写入状态
局部 fake clock、临时方法探针与测试 Game；结束时恢复原方法。

调用函数
createResponseDecisionInput、runSearchRequest、projectProbabilityWork、shouldRespond。

边界与不变量
仅以受控时钟触发资源耗尽，不改变 utility 公式或概率算法。
*/
export async function verifyResponseBudget({ makeGame, makePlayer, instance }) {
  const actor = makePlayer("budget-source", 0, "dusk", "ai", 4);
  const responder = makePlayer("budget-responder", 1, "dawn", "ai", 0);
  const ally = makePlayer("budget-ally", 2, "dawn", "ai", 1);
  responder.hand.push(instance("counter"));
  const { game } = makeGame([actor, responder, ally]);
  const card = instance("mutualBenefit");
  let captured;
  game.aiController.searchExecutor = { async search(request) {
    captured = structuredClone(request);
    return runSearchRequest(request, { now:() => 0 });
  } };
  const originalBuild = Simulator.prototype.buildRootFlipWorlds;
  const originalEvaluate = Evaluator.prototype.shouldRespond;
  let clock = 0, evaluations = 0, projected = 0, budgetSeen = null;
  try {
    const baseline = await game.aiController.shouldRespond(responder, "counter", {
      source:actor, rootSource:actor, card, rootCard:card, rootTargetIds:[responder.id]
    }, responder.hand);
    assert.equal(game.aiController.lastAuxiliaryDecisionDiagnostics.stopReason, "COMPLETE");
    Evaluator.prototype.shouldRespond = function (...args) {
      const result = originalEvaluate.apply(this, args);
      clock = 2999;
      return result;
    };
    const complete = await runSearchRequest(structuredClone(captured), { now:() => clock });
    assert.equal(complete.decision, baseline);
    assert.equal(complete.stats.responseStopReason, "COMPLETE");
    Evaluator.prototype.shouldRespond = originalEvaluate;
    clock = 0;

    // 在真实概率 projector 中越过期限，下一细粒度 checkpoint 必须 unwind 整次响应。
    Simulator.prototype.buildRootFlipWorlds = function (...args) {
      budgetSeen = this.searchBudget;
      assert.ok(budgetSeen);
      assert.equal(budgetSeen.nodeBudget, null);
      assert.equal(budgetSeen.timeBudget, 3000);
      this.projectProbabilityWork(Array.from({ length:96 }, () => ({ probability:1 / 96 })), (branch) => {
        projected += 1;
        clock = 3000;
        return branch;
      });
      throw new Error("partial probability result escaped");
    };
    Evaluator.prototype.shouldRespond = function (...args) {
      evaluations += 1;
      return originalEvaluate.apply(this, args);
    };
    const timed = await runSearchRequest(structuredClone(captured), { now:() => clock });
    assert.equal(timed.decision, false);
    assert.equal(timed.stats.responseStopReason, "TIME");
    assert.ok(projected > 0 && projected < 96);
    assert.equal(evaluations, 0, "不完整 Worlds 不得进入最终 utility");
    assert.equal(budgetSeen.abortedCooperativeProbabilityOperations, 1);
    Simulator.prototype.buildRootFlipWorlds = originalBuild;

    clock = 0;
    Evaluator.prototype.shouldRespond = function () { evaluations += 1; clock = 3000; return true; };
    const lateUtility = await runSearchRequest(structuredClone(captured), { now:() => clock });
    assert.equal(lateUtility.decision, false, "最终比较越过期限也不得发布 true");
    assert.equal(lateUtility.stats.responseStopReason, "TIME");
    assert.equal(evaluations, 1);

    for (const stop of ["TIME", "CANCELLED"]) {
      clock = 0;
      const outcome = await runSearchRequest(structuredClone(captured), {
        now:() => clock,
        yieldControl:async () => { clock = stop === "TIME" ? 3000 : 0; return stop !== "CANCELLED"; }
      });
      assert.equal(outcome.decision, false);
      assert.equal(outcome.stats.responseStopReason, stop);
      assert.equal(evaluations, 1);
    }
    Evaluator.prototype.shouldRespond = originalEvaluate;
    const next = await runSearchRequest(structuredClone(captured), { now:() => 0 });
    assert.equal(next.decision, baseline, "下一 Response 使用全新预算");
    assert.equal(next.stats.responseStopReason, "COMPLETE");

    for (const stop of ["TIME", "CANCELLED"]) {
      game.aiController.searchExecutor = { async search(request) {
        return { kind:request.kind, requestId:request.requestId, gameId:request.gameId,
          decision:true, stats:{ responseStopReason:stop } };
      } };
      assert.equal(await game.aiController.requestDecision("RESPONSE_DECISION", responder, captured.input), false);
      assert.equal(game.aiController.lastAuxiliaryDecisionDiagnostics.status, stop);
    }
  } finally {
    Simulator.prototype.buildRootFlipWorlds = originalBuild;
    Evaluator.prototype.shouldRespond = originalEvaluate;
    game.dispose();
  }
}

/*
功能
用 fake Worker/timer 验证 Response 绝对期限、终止重建、迟到隔离和后续计算。

调用方
AI Worker 定向测试。

输入
canonical Game fixture helpers。

输出
Promise<void>；生命周期或结果合同违反时断言失败。

读取状态
Worker client 与 Controller 的真实诊断和 pending 生命周期。

写入状态
局部 timer Map、fake Worker 与测试 Game；结束恢复 global Worker。

调用函数
createSearchWorkerClient、requestDecision、runSearchRequest。

边界与不变量
时间由测试触发，不等待真实十秒；后续 Search 和 Response 执行正式 Worker runtime。
*/
export async function verifyResponseWatchdog({ makeGame, makePlayer, instance }) {
  const previousWorker = Object.getOwnPropertyDescriptor(globalThis, "Worker");
  const workers = [], timers = new Map();
  let timerId = 0;
  class FakeWorker {
    constructor() { this.listeners = new Map(); this.posted = []; this.terminated = false; workers.push(this); }
    addEventListener(type, listener) { this.listeners.set(type, listener); }
    postMessage(message) { this.posted.push(message); }
    terminate() { this.terminated = true; }
    emit(message) { this.listeners.get("message")({ data:message }); }
  }
  Object.defineProperty(globalThis, "Worker", { configurable:true, value:FakeWorker });
  const client = createSearchWorkerClient("fake-worker.js", {
    setTimeout(callback, ms) { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  const actor = makePlayer("watchdog-actor", 0, "dawn", "ai", 0);
  const enemy = makePlayer("watchdog-enemy", 1, "dusk", "ai", 4);
  const { game } = makeGame([actor, enemy]);
  game.searchExecutor.dispose();
  game.aiController.searchExecutor = client;
  const input = game.aiController.createResponseDecisionInput(actor, "block", { source:enemy, target:actor, amount:1 }, []);
  try {
    const createdBeforeCooperative = workers.length;
    let clock = 0;
    const cooperativePending = game.aiController.requestDecision("RESPONSE_DECISION", actor, structuredClone(input));
    const reusable = workers[0], cooperativeSent = reusable.posted[0];
    const cooperativeTimer = [...timers.values()][0];
    const cooperativeOutcome = await runSearchRequest(cooperativeSent.request, {
      now:() => clock,
      yieldControl:async () => { clock = 3000; return true; }
    });
    assert.equal(cooperativeOutcome.decision, false);
    assert.equal(cooperativeOutcome.stats.responseStopReason, "TIME");
    reusable.emit({ type:"RESULT", requestId:cooperativeSent.requestId, outcome:cooperativeOutcome });
    assert.equal(await cooperativePending, false);
    assert.equal(game.aiController.lastAuxiliaryDecisionDiagnostics.status, "TIME");
    assert.equal(game.aiController.lastAuxiliaryDecisionDiagnostics.watchdogFired, undefined);
    assert.equal(reusable.terminated, false, "cooperative TIME 正常返回不得 terminate Worker");
    assert.equal(workers.length, createdBeforeCooperative);
    assert.equal(timers.size, 0);
    cooperativeTimer.callback();
    assert.equal(reusable.terminated, false, "cooperative terminal 后旧 hard watchdog 不得误杀 Worker");

    const pending = game.aiController.requestDecision("RESPONSE_DECISION", actor, input);
    const old = workers[0], sent = old.posted[0];
    const timeout = [...timers.values()][0];
    assert.equal(timeout.ms, 10000);
    old.emit({ type:"HEARTBEAT", requestId:sent.requestId });
    assert.equal([...timers.values()][0], timeout, "heartbeat 不得续期绝对 deadline");
    const createdBeforeTimeout = workers.length;
    timeout.callback();
    assert.equal(old.terminated, true);
    assert.equal(workers.length, createdBeforeTimeout + 1);
    assert.equal(await pending, false);
    assert.equal(game.aiController.lastAuxiliaryDecisionDiagnostics.status, "TIME");
    assert.equal(game.aiController.lastAuxiliaryDecisionDiagnostics.watchdogFired, true);
    assert.equal(timers.size, 0);

    const next = game.aiController.requestDecision("RESPONSE_DECISION", actor, structuredClone(input));
    const current = workers.at(-1), nextSent = current.posted.at(-1);
    let settled = false;
    next.then(() => { settled = true; });
    // 连旧实例伪装成当前 requestId 也必须被实例身份挡住。
    old.emit({ type:"RESULT", requestId:nextSent.requestId, outcome:{ decision:true } });
    current.emit({ type:"RESULT", requestId:sent.requestId, outcome:{ decision:true } });
    timeout.callback();
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(current.terminated, false);
    const successTimer = [...timers.values()][0];
    const response = await runSearchRequest(nextSent.request, { now:() => 0 });
    current.emit({ type:"RESULT", requestId:nextSent.requestId, outcome:response });
    assert.equal(await next, response.decision);
    assert.equal(timers.size, 0);
    successTimer.callback();
    assert.equal(current.terminated, false, "成功后已入队旧 timer 也不得误杀 Worker");

    // 正常 AI Turn 仍可通过同一重建 client 进行正式搜索。
    const search = game.aiController.selectAction(actor);
    const searchSent = current.posted.at(-1);
    assert.equal(searchSent.type, "SEARCH");
    const searchRequest = structuredClone(searchSent.request);
    searchRequest.searchConfig.nodeBudget = 2;
    const searchOutcome = await runSearchRequest(searchRequest);
    current.emit({ type:"RESULT", requestId:searchSent.requestId, outcome:searchOutcome });
    await search;
    assert.equal(game.aiController.lastWorkerOutcome.requestId, searchSent.requestId);
    assert.equal(timers.size, 0);

    for (const terminal of ["ERROR", "cancel", "error", "messageerror", "dispose"]) {
      const result = game.aiController.requestDecision("RESPONSE_DECISION", actor, structuredClone(input));
      const observed = result.then(value => ({ value }), error => ({ error }));
      const occupied = workers.at(-1), message = occupied.posted.at(-1);
      const staleTimer = [...timers.values()][0];
      if (terminal === "cancel") client.cancel(message.requestId);
      else if (terminal === "dispose") client.dispose();
      else if (terminal === "ERROR") occupied.emit({ type:"ERROR", requestId:message.requestId, workerError:"expected fault" });
      else occupied.listeners.get(terminal)({ message:"expected crash" });
      const outcome = await observed;
      if (["cancel", "dispose"].includes(terminal)) assert.equal(outcome.value, false);
      else assert.ok(outcome.error);
      assert.equal(timers.size, 0, terminal);
      const created = workers.length;
      staleTimer.callback();
      assert.equal(workers.length, created);
    }
  } finally {
    client.dispose(); game.dispose();
    if (previousWorker) Object.defineProperty(globalThis, "Worker", previousWorker);
    else delete globalThis.Worker;
  }
}

/*
功能
验证 canonical response options 的强制反制策略与原支付顺序。

调用方
AI 反制定向测试。

输入
canonical Game fixture helpers。

输出
Promise<void>；策略范围或支付数量不符时断言失败。

读取状态
Application response options、公开响应对象与私有合法实体绑定。

写入状态
fixture 手牌支付与 adapter 调用计数。

调用函数
requestCardResponse、createAiChoiceAdapter、createResponseChoiceRequest。

边界与不变量
命中时禁止进入 Controller utility 链；混合集合、其它对象或特殊响应继续原决策。
*/
export async function verifyForcedCounter({ makeGame, makePlayer, instance }) {
  for (const definitionId of ["destroy", "plunder", "transfer"]) {
    for (const count of [1, 2, 3, 5]) {
      const source = makePlayer("forced-source", 0, "dusk", "ai", 4);
      const responder = makePlayer("forced-responder", 1, "dawn", "ai", 0);
      const counters = Array.from({ length:count }, () => instance("counter"));
      responder.hand.push(instance("charge"), ...counters);
      const { game } = makeGame([source, responder]);
      game.aiController.shouldRespond = () => { throw new Error("forced Counter entered Response Decision"); };
      try {
        const card = instance(definitionId);
        const result = await game.responseWorkflow.requestCardResponse(responder, "counter", { source, card }, 1);
        assert.equal(result.status, "used", `${definitionId}/${count}`);
        assert.deepEqual(result.cards.map(entry => entry.id), [counters[0].id]);
        assert.equal(responder.hand.filter(entry => entry.definitionId === "counter").length, count - 1);
        assert.ok(responder.hand.some(entry => entry.definitionId === "charge"), "无关原始手牌不改变合法响应集合");
      } finally { game.dispose(); }
    }
  }
  for (const scenario of ["empty", "mixed", "other", "nested", "skill", "block", "unbound"]) {
    let calls = 0;
    const cards = scenario === "empty" ? [] : [instance("counter")];
    if (scenario === "mixed") cards.push(instance("block"));
    const card = instance(["other", "block"].includes(scenario) ? "assault" : scenario === "nested" ? "counter" : "destroy");
    const request = createResponseChoiceRequest({
      requestId:`policy-${scenario}`, actorId:"actor", gameId:"policy-game", stateVersion:1,
      responseType:["skill", "block"].includes(scenario) ? scenario : "counter", requiredCount:1,
      legalCardIds:scenario === "unbound" ? ["unbound-id"] : cards.map(entry => entry.id), context:{ cardId:card.id }
    });
    const adapter = createAiChoiceAdapter({
      getChoiceContext:() => ({ responder:{ id:"actor", battleTeam:"dawn" }, cards,
        context:{ source:{ id:"source", battleTeam:"dusk" }, card, rootCard:instance("destroy") } }),
      shouldRespond:async () => { calls += 1; return false; },
      choosePublicCard:() => null, chooseDiscards:() => [], isSessionValid:() => true
    });
    assert.equal((await adapter.request(request)).status, "declined", scenario);
    assert.equal(calls, scenario === "empty" ? 0 : 1, scenario);
  }
}

/*
功能
验证强制反制只针对当前来源明确敌对的资源牌。

调用方
AI 反制定向测试。

输入
canonical card fixture helper。

输出
Promise<void>；阵营或当前来源边界不符时断言失败。

读取状态
canonical source/responder battleTeam 与 response options。

写入状态
局部 shouldRespond 调用计数。

调用函数
createAiChoiceAdapter、createResponseChoiceRequest。

边界与不变量
rootSource 的阵营刻意与当前来源相反，不能用历史来源替代当前 card 的施放者。
*/
export async function verifyForcedCounterTeams({ instance }) {
  for (const definitionId of ["destroy", "plunder", "transfer"]) {
    for (const relation of ["enemy", "ally", "unknownSource", "unknownSourceTeam", "unknownResponderTeam"]) {
      const card = instance(definitionId), counter = instance("counter");
      const source = relation === "unknownSource" ? null : {
        id:"current-source", battleTeam:relation === "unknownSourceTeam" ? null : relation === "ally" ? "dawn" : "dusk"
      };
      const responder = { id:"responder", battleTeam:relation === "unknownResponderTeam" ? null : "dawn" };
      const request = createResponseChoiceRequest({
        requestId:`teams-${definitionId}-${relation}`, actorId:responder.id, gameId:"team-game", stateVersion:1,
        responseType:"counter", requiredCount:1, legalCardIds:[counter.id], context:{ cardId:card.id }
      });
      let calls = 0;
      const adapter = createAiChoiceAdapter({
        getChoiceContext:() => ({ responder, cards:[counter], context:{ source, card,
          rootSource:{ id:"older-source", battleTeam:relation === "enemy" ? "dawn" : "dusk" }, rootCard:card } }),
        shouldRespond:async () => { calls += 1; return false; },
        choosePublicCard:() => null, chooseDiscards:() => [], isSessionValid:() => true
      });
      const result = await adapter.request(request);
      const force = relation === "enemy";
      assert.equal(result.status, force ? "selected" : "declined", `${definitionId}/${relation}`);
      assert.equal(calls, force ? 0 : 1, `${definitionId}/${relation}`);
      if (force) assert.deepEqual(result.selectedIds, [counter.id]);
    }
  }
}
