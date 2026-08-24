/*
模块职责
唯一拥有 Diagnostic Ledger（诊断账本：解释价值来源但不参与选牌）的角色归属、响应与候选 schema 和投影规则。

上游
Planner 诊断、正式边界 与价值归属测试。

下游
纯 Evaluator、运行时 State Value、闪电/响应模拟查询与封印纯函数。

状态边界
只读 before/after World；不修改输入状态。

信息边界
只使用过滤后的玩家字段和合法概率摘要。

架构约束
账本解释已有价值，不是第二个 Evaluator；所有响应/候选字段仅供诊断，开关不得改变最终价值或选择。
*/
import { buildRadarJudgmentProbabilities } from "../domain/RadarModel.js";
import {
  queryCurrentCardCounts,
  queryPlayerHandProbability
} from "../state/Probability.js";
import { statePointsToUtility } from "./Economics.js";
import { sealTeamBurden } from "./SealValue.js";

export class ValueLedger {
  /*
  功能
  绑定共享状态 primitive、完整 State Value 与上游 simulation query。

  调用方
  AIController 组合根（统一组装依赖的位置）。

  输入
  evaluator、stateValue 与 simulationQuery 三个显式依赖。

  输出
  诊断账本服务实例。

  读取状态
  保存依赖引用。

  写入状态
  写入实例依赖字段。

  调用函数
  无。

  边界与不变量
  不接受 Game、Planner 或 Controller；账本开关不得改变生产评分。
  */
  constructor({ evaluator, stateValue, simulationQuery }) {
    this.evaluator = evaluator;
    this.stateValue = stateValue;
    this.simulationQuery = simulationQuery;
  }

  /*
  功能
  把一次 state transition 分解到每个 owner 的互斥价值类别。

  调用方
  computeCandidateLedger、正式边界 与价值归属测试。

  输入
  before、after、viewer ID 与可选父 SearchBudget。

  输出
  包含 owners 和未签名 owner total 的账本。

  读取状态
  只读共享 state primitive、封印 burden 与闪电 owner delta。

  写入状态
  无；闪电查询只写自身缓存。

  调用函数
  Evaluator.playerValueTerms、sealTeamBurden、lightningOwnerDelta。

  边界与不变量
  每个字段只归属于一个 owner；团队符号只在 projectOwnerLedger 施加；
  闪电 nested simulation 必须继承父 SearchBudget。
  */
  ownerStateLedger(before, after, viewerId, searchBudget = null) {
    const radarTactic = buildRadarJudgmentProbabilities(
      queryCurrentCardCounts(after.probabilityState)
    ).tactic;
    const viewer = after.players.find((player) => player.id === viewerId)
      ?? before.players.find((player) => player.id === viewerId);
    const beforePlayers = new Map(before.players.map((player) => [player.id, player]));
    const owners = [];
    for (const afterPlayer of after.players) {
      const beforePlayer = beforePlayers.get(afterPlayer.id);
      if (!beforePlayer) continue;
      const relation = afterPlayer.battleTeam === viewer.battleTeam
        ? (afterPlayer.id === viewerId ? "self" : "ally")
        : "enemy";
      const beforeTerms = this.evaluator.playerValueTerms(
        before,
        beforePlayer,
        viewerId,
        radarTactic
      );
      const afterTerms = this.evaluator.playerValueTerms(
        after,
        afterPlayer,
        viewerId,
        radarTactic
      );
      const beforeBurden = {
        lightning: this.simulationQuery.lightningOwnerDelta(
          before,
          beforePlayer.id,
          viewerId,
          searchBudget
        ),
        seal: sealTeamBurden(before, beforePlayer, viewer.battleTeam, searchBudget)
      };
      const afterBurden = {
        lightning: this.simulationQuery.lightningOwnerDelta(
          after,
          afterPlayer.id,
          viewerId,
          searchBudget
        ),
        seal: sealTeamBurden(after, afterPlayer, viewer.battleTeam, searchBudget)
      };
      const fields = {};
      for (const key of new Set([
        ...Object.keys(beforeTerms.terms),
        ...Object.keys(afterTerms.terms)
      ])) {
        fields[key] = (afterTerms.terms[key] ?? 0) - (beforeTerms.terms[key] ?? 0);
      }
      fields.death = afterTerms.death - beforeTerms.death;
      fields.lightning = afterBurden.lightning - beforeBurden.lightning;
      fields.seal = afterBurden.seal - beforeBurden.seal;
      const total = Object.values(fields).reduce((sum, value) => sum + value, 0);
      owners.push({
        playerId: afterPlayer.id,
        relation,
        total,
        generic: { handCount: fields.handCount ?? 0, energy: fields.energy ?? 0 },
        material: {
          hp: fields.hp ?? 0,
          shield: fields.shield ?? 0,
          hp2Risk: fields.hp2Risk ?? 0,
          info: fields.info ?? 0,
          stacks: fields.stacks ?? 0,
          equipmentDelta: fields.equipmentDelta ?? 0,
          energyDeviceFuture: fields.energyDeviceFuture ?? 0,
          death: fields.death ?? 0
        },
        threat: {
          currentThreat: fields.currentThreat ?? 0,
          futureInventory: fields.futureInventory ?? 0,
          energyPressure: fields.energyPressure ?? 0,
          markThreat: fields.markThreat ?? 0,
          radar: fields.radar ?? 0
        },
        specific: {
          handRole: fields.handRole ?? 0,
          equipmentRole: fields.equipmentRoleDelta ?? 0
        },
        outcome: {
          danger: fields.danger ?? 0,
          rescueOutlook: fields.rescueOutlook ?? 0
        },
        teamBurden: {
          lightning: fields.lightning ?? 0,
          seal: fields.seal ?? 0
        }
      });
    }
    const total = owners.reduce((sum, owner) => sum + owner.total, 0);
    return { perspectiveId: viewerId, owners, total };
  }

  /*
  功能
  把 owner-local ledger 投影为 viewer 的 self、ally、enemy 与 total。

  调用方
  computeCandidateLedger、正式边界 与测试。

  输入
  owner ledger 与 viewer ID。

  输出
  敌方收益取反后的团队视角投影。

  读取状态
  只读账本对象。

  写入状态
  无。

  调用函数
  statePointsToUtility。

  边界与不变量
  projected.total 是显式 Final Utility 诊断，必须等于同一 before/after 原始 State points
  delta 经 statePointsToUtility 的单次边界换算。
  */
  projectOwnerLedger(ledger, viewerId) {
    const self = ledger.owners.find((owner) => owner.playerId === viewerId);
    const allies = ledger.owners.filter((owner) => owner.relation === "ally");
    const enemies = ledger.owners.filter((owner) => owner.relation === "enemy");
    const selfValue = statePointsToUtility(self?.total ?? 0);
    const allyValue = statePointsToUtility(
      allies.reduce((sum, owner) => sum + owner.total, 0)
    );
    const enemyValue = statePointsToUtility(
      enemies.reduce((sum, owner) => sum + owner.total, 0)
    );
    return {
      perspectiveId: viewerId,
      self: selfValue,
      ally: allyValue,
      enemy: enemyValue,
      total: selfValue + allyValue - enemyValue
    };
  }

  /*
  功能
  暴露同一事件响应反事实的正式查询入口。

  调用方
  Planner 与 computeResponseLedger。

  输入
  before、动作、actor/defender/viewer ID、移除项、可选 actual after 与父 SearchBudget。

  输出
  grossAvoided、ownerValue 与 projected value。

  读取状态
  只读过滤后的配对状态。

  写入状态
  无；simulation query 只写独立克隆。

  调用函数
  ValueSimulationQuery.responseCounterfactual。

  边界与不变量
  本层不模拟也不改公式，只把正式 State Value 与父 SearchBudget 显式交给 ValueSimulationQuery。
  */
  responseCounterfactual(
    before,
    action,
    actorId,
    defenderId,
    viewerId,
    opts = {},
    after = null,
    searchBudget = null
  ) {
    return this.simulationQuery.responseCounterfactual(
      before,
      action,
      actorId,
      defenderId,
      viewerId,
      opts,
      after,
      this.stateValue,
      searchBudget
    );
  }

  /*
  功能
  识别一次 transition 中实际消费的 block、counter 与 rescue，并归属响应价值。

  调用方
  computeCandidateLedger 与测试。

  输入
  before、动作、after、viewer ID 与可选父 SearchBudget。

  输出
  responses 数组。

  读取状态
  只读响应概率、手牌计数与恢复容量。

  写入状态
  无。

  调用函数
  responseCounterfactual。

  边界与不变量
  响应值已包含在 state delta 中，仅作 owner attribution，不能再次加进 final value。
  */
  computeResponseLedger(before, action, after, viewerId, searchBudget = null) {
    if (!action) return { responses: [] };
    const beforeById = new Map(before.players.map((player) => [player.id, player]));
    const actorId = viewerId;
    const responses = [];
    for (const player of after.players) {
      if (player.id === actorId || !player.alive) continue;
      const beforePlayer = beforeById.get(player.id);
      if (!beforePlayer) continue;
      const blockDropped = queryPlayerHandProbability(
        before.probabilityState, beforePlayer, "block"
      ).probability - queryPlayerHandProbability(
        after.probabilityState, player, "block"
      ).probability > 1e-9;
      const counterDropped = queryPlayerHandProbability(
        before.probabilityState, beforePlayer, "counter"
      ).probability - queryPlayerHandProbability(
        after.probabilityState, player, "counter"
      ).probability > 1e-9;
      if (blockDropped || counterDropped) {
        const counterfactual = this.responseCounterfactual(
          before,
          action,
          actorId,
          player.id,
          viewerId,
          { removeBlock: blockDropped, removeCounter: counterDropped },
          after,
          searchBudget
        );
        responses.push({
          kind: blockDropped && counterDropped
            ? "blockAndCounter"
            : blockDropped ? "block" : "counter",
          responderId: player.id,
          protectedId: player.id,
          resourceSpent: Math.max(
            0,
            (beforePlayer.handCount ?? 0) - (player.handCount ?? 0)
          ) * 1.1,
          grossAvoided: counterfactual.grossAvoided,
          ownerValue: counterfactual.ownerValue,
          netValue: counterfactual.projected
        });
      }
    }
    for (const rescuer of after.players) {
      if (rescuer.id === actorId || !rescuer.alive) continue;
      const beforeRescuer = beforeById.get(rescuer.id);
      if (!beforeRescuer) continue;
      const recoverSpent = queryPlayerHandProbability(
        before.probabilityState, beforeRescuer, "recover"
      ).expected - queryPlayerHandProbability(
        after.probabilityState, rescuer, "recover"
      ).expected;
      if (recoverSpent > 1e-9) {
        const counterfactual = this.responseCounterfactual(
          before,
          action,
          actorId,
          rescuer.id,
          viewerId,
          { removeRecover: true },
          after,
          searchBudget
        );
        responses.push({
          kind: "rescue",
          responderId: rescuer.id,
          protectedId: null,
          resourceSpent: recoverSpent * 1.1,
          grossAvoided: counterfactual.grossAvoided,
          ownerValue: counterfactual.ownerValue,
          netValue: counterfactual.projected
        });
      }
    }
    return { responses };
  }

  /*
  功能
  构造根候选的 owner、projection 与 response 诊断账本。

  调用方
  Planner 的显式 diagnostics 路径与测试。

  输入
  before、动作、after、viewer ID、是否计算响应反事实与可选父 SearchBudget。

  输出
  ownerLedger、projected 与 responses。

  读取状态
  只读过滤后的 before/after。

  写入状态
  无。

  调用函数
  ownerStateLedger、projectOwnerLedger、computeResponseLedger。

  边界与不变量
  生产 diagnostics 关闭时不得调用本方法；返回字段不参与候选评分。
  */
  computeCandidateLedger(
    before,
    action,
    after,
    viewerId,
    includeResponse,
    searchBudget = null
  ) {
    const ownerLedger = this.ownerStateLedger(before, after, viewerId, searchBudget);
    const projected = this.projectOwnerLedger(ownerLedger, viewerId);
    const responses = includeResponse
      ? this.computeResponseLedger(before, action, after, viewerId, searchBudget).responses
      : [];
    return { ownerLedger, projected, responses };
  }
}
