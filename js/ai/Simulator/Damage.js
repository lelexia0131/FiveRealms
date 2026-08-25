/*
模块职责
镜像 World 中的伤害、失去生命、治疗、濒死救援和死亡生命周期。

上游
Simulator 正式模拟门面。

下游
Domain Combat/Response Rules、CardDefinitions 与 canonical Probability facade。

状态边界
只修改 Simulator 门面提供的独立 World 副本，不持有真实 GameState。

信息边界
只消费可见/概率摘要，不读取隐藏实体牌或未来牌堆。

架构约束
结算顺序以 Domain CombatRules、CombatWorkflow 与 DyingWorkflow 为权威；不得拥有 Policy 或 Value 公式。
*/
import { CARD_DEFINITIONS as DOMAIN_CARD_DEFINITIONS } from "../../domain/definitions/cards/CardDefinitions.js";
import { PASSIVE_SKILL_DEFINITIONS } from "../../domain/definitions/skills/SkillDefinitions.js";
import { RULESET_DEFINITION } from "../../domain/definitions/ruleset/RulesetDefinition.js";
import {
  calculateHealAmount,
  calculateHpDamage,
  calculateShieldAbsorption,
  isDying,
  isKillRewardEligible
} from "../../domain/rules/combat/CombatRules.js";
import { getRequiredBlockCount } from "../../domain/rules/response/ResponseRules.js";
import { getDyingRescueResponderOrder } from "../../domain/rules/response/ResponseRules.js";
import { hasPassiveSkill, projectCanonicalSeatRoster } from "../Event/Fact.js";
import {
  PROBABILITY_CLASSIFICATION,
  PROBABILITY_EPSILON,
  clampProbability,
  expectedAnonymousSlots,
  expectedBranchValue,
  mutateProbability,
  probabilityEventPartition,
  queryHandProbability,
  queryPlayerHandProbability,
  totalBranchProbability
} from "../Event/Probability/Probability.js";

const RADAR_BASIC_DEFINITION_IDS = Object.freeze(
  Object.values(DOMAIN_CARD_DEFINITIONS)
    .filter((definition) => definition.category === "basic")
    .map((definition) => definition.definitionId)
);

/*
功能
把 Base class 与 Damage 生命周期方法组合成单一 Simulator 类型。

调用方
Simulator.js 文件末尾的组合表达式：在模块加载时把 CombatSimulation 方法加入正式模拟门面。

输入
已经包含上一层模拟能力的 Base class；传入的是类定义，不是搜索节点实例。

输出
继承 Base 并新增伤害、濒死与治疗方法的 class 定义；不创建 Simulator 实例。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
只在模块加载时组合一次；搜索节点不得重复创建组件类或改变方法覆盖顺序。
*/
export const withDamage = (Base) => class Damage extends Base {
  /*
  功能
  把伤害条件世界投影为 HP/存活分支，并明确标记标量 HP 是否只是期望摘要。

  调用方
  applyDamage 在护盾和实际生命伤害确定后。

  输入
  World、目标、伤害世界与逐世界生命伤害查询。

输出
  只在本次伤害调用栈存在的 hp/alive 结果分区。

  读取状态
  目标既有 HP 分支与同阵营调息期望容量。

写入状态
  hpSummaryClassification、aliveProbability、alive 与标量 hp。

  调用函数
  getHpStateBranches、intersectProbabilityStateBranches、projectProbabilityStateBranches。

边界与不变量
  无救援容量时死亡边界按每个世界离散结算；可能救援的濒死世界保留为非 exact 限制，
  绝不把跨边界的 expected HP 宣称为确定状态，局部结果分区不写回 World。
  */
  commitHpOutcomeBranches(state, target, damageWorlds, hpDamageFor) {
    const hpWorlds = damageWorlds.map((branch) => ({
      ...branch,
      hp:Number(target.hp) || 0,
      alive:Boolean(target.alive)
    }));
    const rescueCapacity = (state?.players ?? []).filter((player) => (
      player.alive && player.battleTeam === target.battleTeam
    )).reduce((sum, player) => sum + queryHandProbability(state.probabilityState, {
      bucketId:player.id,
      knownResources:[
        ...(Array.isArray(player.hand) ? player.hand : []),
        ...(Array.isArray(player.knownCards) ? player.knownCards : [])
      ],
      definitionId:"recover"
    }).expected, 0);
    let hasUnresolvedRescue = false;
    if (rescueCapacity > PROBABILITY_EPSILON) {
      for (let index = 0; index < hpWorlds.length; index += 1) {
        if (index % 32 === 0) this.checkpointSearchWork();
        const branch = hpWorlds[index];
        if (!branch.alive || branch.hp - hpDamageFor(branch) > 0) continue;
        hasUnresolvedRescue = true;
        break;
      }
    }
    const branches = this.projectProbabilityWork(hpWorlds, (branch) => {
      const hpAfterDamage = branch.alive ? branch.hp - hpDamageFor(branch) : branch.hp;
      const survivesWithoutRescue = branch.alive && hpAfterDamage > 0;
      return {
        hp:survivesWithoutRescue || hasUnresolvedRescue ? hpAfterDamage : 0,
        alive:hasUnresolvedRescue ? branch.alive : survivesWithoutRescue
      };
    }, "CombatSimulation.commitHpOutcomeBranches:project");
    const distinct = new Set();
    let aliveProbability = 0;
    let expectedHp = 0;
    for (let index = 0; index < branches.length; index += 1) {
      if (index % 32 === 0) this.checkpointSearchWork();
      const branch = branches[index];
      distinct.add(`${branch.hp}|${branch.alive}`);
      if (branch.alive) aliveProbability += branch.probability;
      expectedHp += branch.hp * branch.probability;
    }
    target.hpSummaryClassification = distinct.size > 1
      ? PROBABILITY_CLASSIFICATION.EXPECTED_VALUE
      : PROBABILITY_CLASSIFICATION.EXACT;
    target.aliveProbability = aliveProbability;
    target.alive = aliveProbability > PROBABILITY_EPSILON;
    target.hp = expectedHp;
    return branches;
  }

  /*
  功能
  按多槽雷达、格挡、实际生命伤害护援、护盾、生命、救援与伤后钩子的真实顺序结算条件化伤害世界。

  调用方
  CardEffect、SkillEffect、Status、ValueSimulationQuery 与本模块攻击入口：镜像一次条件化伤害。

  输入
  独立 World、可空攻击者、存活目标、正伤害量与格挡/装备/事件选项。

  输出
  期望生命伤害量；可选 outcome 同步得到伤害与格挡概率分支。

  读取状态
  事件世界、攻防装备、格挡容量、护援能力、护盾/生命分支与状态钩子。

  写入状态
  格挡身份和容量、护援资源、护盾、生命、濒死/死亡及伤后状态。

  调用函数
  buildRadarOutcomeSequencePartition、consumeBlockResponseWorlds、simulateGuardianAid、resolveFatal 与伤后钩子。

  边界与不变量
  顺序固定为逐需求雷达→格挡→pending HP damage 护援→护盾/生命 commit→伤后钩子→濒死；同一响应资源不得重复消费。
  */
  applyDamage(state, attacker, target, amount, options = {}) {
    if (!target.alive || amount <= 0) {
      if (options.outcome) {
        options.outcome.lifeDamageChance = 0;
        options.outcome.blockedByCardChance = 0;
      }
      return 0;
    }
    const eventWorlds = this.getEventWorlds(state,
      options.eventProbability ?? 1,
      options.eventBranches,
      `damage-event:${attacker?.id ?? "unknown"}:${target.id}`);
    const eventProbability = this.eventProbability(eventWorlds);
    if (eventProbability <= 0) return 0;
    const amountState = (Array.isArray(options.amountBranches) && options.amountBranches.length
      ? this.mergeProbabilityWork(
          options.amountBranches,
          "CombatSimulation.applyDamage:amount"
        )
      : [{ probability:1, conditions:{}, amount }]).map((branch) => ({
      probability:branch.probability,
      conditions:branch.conditions,
      damageAmount:Math.max(0, Number(branch.amount) || 0)
    }));
    const battleProbability = clampProbability(options.deviceAttack
      && attacker.equipmentDefinitionId === "battleDevice"
      ? (options.attackerEquipmentProbability ?? this.getSimulatedEquipmentProbability(attacker, "battleDevice"))
      : 0);
    // 雷达按统一“需要打出格挡”语义生效：只要本次伤害可格挡（options.canBlock），
    // 目标装备 defenseDevice 时就进入雷达判定路径，不再依赖 assault/shock 牌名白名单。
    const defenseProbability = options.canBlock
      ? this.getSimulatedEquipmentProbability(target, "defenseDevice")
      : 0;
    let blockedByCardChance = 0;
    let expectedBlockSpend = 0;
    let passChance = 1;
    let attackOutcomeWorlds = null;
    if (defenseProbability > 0) {
      const battleKey = this.currentProbabilityEventKey(
        state,
        `battle-required:${attacker?.id ?? "unknown"}:${target.id}`
      );
      const requiredPartition = battleProbability >= 1 - PROBABILITY_EPSILON
        ? [{ probability:1, conditions:{}, requiredCount:getRequiredBlockCount("battleDevice", true) }]
        : battleProbability <= PROBABILITY_EPSILON
          ? [{ probability:1, conditions:{}, requiredCount:getRequiredBlockCount(null, true) }]
          : [
              {
                probability:battleProbability,
                conditions:{ [battleKey]:"yes" },
                requiredCount:getRequiredBlockCount("battleDevice", true)
              },
              {
                probability:1 - battleProbability,
                conditions:{ [battleKey]:"no" },
                requiredCount:getRequiredBlockCount(null, true)
              }
            ];
      const radarPresencePartition = probabilityEventPartition(
        this.currentProbabilityEventKey(state, `radar-present:${target.id}`),
        defenseProbability,
        "hasRadar"
      );
      const maximumRequirement = Math.max(
        0,
        ...requiredPartition.map((branch) => Math.max(0, Math.floor(Number(branch.requiredCount) || 0)))
      );
      const radarOutcomeSequence = this.buildRadarOutcomeSequencePartition(
        state,
        maximumRequirement,
        options.radarJudgmentProbabilities,
        options.radarJudgmentProbabilitiesByRequirement
      );
      const joinedBaseWorlds = this.intersectProbabilityWork(
        [eventWorlds, requiredPartition, radarPresencePartition, radarOutcomeSequence],
        "CombatSimulation.applyDamage:radar-base"
      );
      const baseWorlds = joinedBaseWorlds.map((branch, index) => {
        if (index % 32 === 0) this.checkpointSearchWork();
        const originalRequiredCount = branch.requiredCount;
        const radarOutcomes = branch.hasRadar && branch.occurs
          ? branch.radarOutcomes.slice(0, originalRequiredCount)
          : Array.from({ length:originalRequiredCount }, () => null);
        const waivedBlockCount = branch.hasRadar && branch.occurs
          ? branch.waivedBlockSlots.slice(0, originalRequiredCount)
            .reduce((sum, waived) => sum + waived, 0)
          : 0;
        return {
          ...branch,
          radarOutcomes,
          waivedBlockCount,
          originalRequiredCount,
          requiredCount:Math.max(0, originalRequiredCount - waivedBlockCount),
          responseAllowed:Boolean(options.canBlock)
        };
      });
      // 先保存判定前的格挡容量：若在判定身份加入后重建分布，新身份会同时进入
      // 根容量和本次增量；该快照也用于判断判定得到的格挡是否真的被消费。
      // 无条件的匿名容量分支在这里显式键化，使判定格挡身份、判定前容量和
      // 最终 blockCount 在后续世界中保持同一条件关联。
      const preJudgmentKey = this.currentProbabilityEventKey(state, "pre-judgment-blocks");
      const preJudgmentBlockState = queryPlayerHandProbability(
        state.probabilityState, target, "block"
      ).distribution.map((branch, index) => ({
        probability:branch.probability,
        conditions:{ ...branch.conditions, [preJudgmentKey]:`v${index}` },
        blockCount:branch.blockCount
      }));
      const judgmentBlockCards = [];
      // 每个基础判定牌分别加入身份；判得格挡可在全部雷达槽位完成后用于当前响应。
      for (let slot = 0; slot < maximumRequirement; slot += 1) {
        for (const definitionId of RADAR_BASIC_DEFINITION_IDS) {
          this.checkpointSearchWork();
          const acquisitionWorlds = this.projectProbabilityWork(
            baseWorlds,
            (branch) => ({
              occurs:Boolean(branch.occurs
                && branch.hasRadar
                && slot < branch.originalRequiredCount
                && branch.radarOutcomes?.[slot] === `basic:${definitionId}`)
            }),
            "CombatSimulation.applyDamage:radar-identity"
          );
          if (this.eventProbability(acquisitionWorlds) <= PROBABILITY_EPSILON) continue;
          const simulatedId = this.nextSimulatedCardId(state, definitionId);
          if (Array.isArray(target.hand)) {
            this.addSimulatedCardToHand(state, target, { id:simulatedId, definitionId }, acquisitionWorlds);
            if (definitionId === "block") {
              const judgedBlock = target.hand.find((card) => card.id === simulatedId) ?? null;
              if (judgedBlock) judgmentBlockCards.push(judgedBlock);
            }
          } else {
            this.addSimulatedKnownCard(state, target, { cardId:simulatedId, definitionId }, acquisitionWorlds);
            if (definitionId === "block") {
              const judgedBlock = target.knownCards.find((entry) => entry.cardId === simulatedId) ?? null;
              if (judgedBlock) judgmentBlockCards.push(judgedBlock);
            }
          }
        }
      }
      const response = this.consumeBlockResponseWorlds(state, target, baseWorlds, {
        preJudgmentBlockState,
        judgmentBlockCards
      });
      attackOutcomeWorlds = response.outcomeWorlds;
      blockedByCardChance = eventProbability > 0
        ? Math.min(1, response.blockedProbability / eventProbability)
        : 0;
    } else if (options.canBlock) {
      // 非雷达路径：格挡数量分布与本次伤害事件世界联合，只有同时发生且数量足够的
      // 世界才消费格挡；消费张数由军火库条件决定（1 或 2）。
      const battleKey = this.currentProbabilityEventKey(
        state,
        `battle-required:${attacker?.id ?? "unknown"}:${target.id}`
      );
      const requiredPartition = battleProbability >= 1 - PROBABILITY_EPSILON
        ? [{ probability:1, conditions:{}, requiredCount:getRequiredBlockCount("battleDevice", true) }]
        : battleProbability <= PROBABILITY_EPSILON
          ? [{ probability:1, conditions:{}, requiredCount:getRequiredBlockCount(null, true) }]
          : [
              {
                probability:battleProbability,
                conditions:{ [battleKey]:"yes" },
                requiredCount:getRequiredBlockCount("battleDevice", true)
              },
              {
                probability:1 - battleProbability,
                conditions:{ [battleKey]:"no" },
                requiredCount:getRequiredBlockCount(null, true)
              }
            ];
      const responseWorlds = this.intersectProbabilityWork(
        [eventWorlds, requiredPartition],
        "CombatSimulation.applyDamage:block"
      ).map((branch) => ({ ...branch, responseAllowed:true }));
      const response = this.consumeBlockResponseWorlds(state, target, responseWorlds);
      const blockedProbability = response.blockedProbability;
      blockedByCardChance = eventProbability > 0
        ? Math.min(1, blockedProbability / eventProbability)
        : 0;
      passChance = Math.max(0, Math.min(1, 1 - blockedByCardChance));
      expectedBlockSpend += response.expectedBlockSpend;
    }
    let damagePassProbability = eventProbability * passChance;
    if (attackOutcomeWorlds) {
      damagePassProbability = 0;
      for (let index = 0; index < attackOutcomeWorlds.length; index += 1) {
        if (index % 32 === 0) this.checkpointSearchWork();
        const branch = attackOutcomeWorlds[index];
        if (branch.occurs && branch.passes) {
          damagePassProbability += Math.max(0, Number(branch.probability) || 0);
        }
      }
    }
    const shieldState = [{
      probability:1,
      conditions:{},
      shieldAmount:Number(target.shield) || 0
    }];
    const aidPassWorlds = attackOutcomeWorlds
      ?? this.intersectProbabilityWork([
        eventWorlds,
        probabilityEventPartition(
          this.currentProbabilityEventKey(state, `damage-pass-aid:${attacker?.id ?? "unknown"}:${target.id}`),
          passChance,
          "passes"
        )
      ], "CombatSimulation.applyDamage:aid-pass");
    const preAidDamageWorlds = this.intersectProbabilityWork(
      [aidPassWorlds, shieldState, amountState],
      "CombatSimulation.applyDamage:pre-aid"
    );
    /*
    功能
    读取护援前真正会穿过护盾落到生命值的伤害量。

    调用方
    applyDamage 的护援资格与最终条件世界投影。

    输入
    含 occurs、passes、damageAmount 与 shieldAmount 的伤害分支。

    输出
    该分支护援前的非负生命伤害。

    读取状态
    无。

    写入状态
    无。

    调用函数
    calculateShieldAbsorption、calculateHpDamage。

    边界与不变量
    未发生或未穿过响应的世界必须为零；只用于决定护援窗口，不提交护盾或生命。
    */
    const preAidHpDamageFor = (branch) => {
      if (!branch.occurs || !branch.passes) return 0;
      const absorbed = calculateShieldAbsorption(branch.shieldAmount, branch.damageAmount);
      return calculateHpDamage(branch.damageAmount, absorbed);
    };
    let pendingLifeDamageProbability = 0;
    let incomingExpectedHpDamage = 0;
    for (let index = 0; index < preAidDamageWorlds.length; index += 1) {
      if (index % 32 === 0) this.checkpointSearchWork();
      const branch = preAidDamageWorlds[index];
      const hpDamage = preAidHpDamageFor(branch);
      if (hpDamage > PROBABILITY_EPSILON) {
        pendingLifeDamageProbability += Math.max(0, Number(branch.probability) || 0);
      }
      incomingExpectedHpDamage += branch.probability * hpDamage;
    }
    let aidReductionPerLifeDamage = 0;
    if (damagePassProbability > PROBABILITY_EPSILON) {
      const aidedExpectedHpDamage = this.simulateGuardianAid(
        state,
        target,
        incomingExpectedHpDamage,
        pendingLifeDamageProbability,
        options.excludedGuardianIds,
        options
      );
      if (pendingLifeDamageProbability > PROBABILITY_EPSILON) {
        aidReductionPerLifeDamage = Math.max(0,
          (incomingExpectedHpDamage - aidedExpectedHpDamage) / pendingLifeDamageProbability);
      }
    }
    const damageWorlds = attackOutcomeWorlds
      ? this.intersectProbabilityWork(
          [attackOutcomeWorlds, shieldState, amountState],
          "CombatSimulation.applyDamage:damage-worlds"
        )
      : this.intersectProbabilityWork([
          eventWorlds,
          probabilityEventPartition(
            this.currentProbabilityEventKey(state, `damage-pass:${attacker?.id ?? "unknown"}:${target.id}`),
            passChance,
            "passes"
          ),
          shieldState,
          amountState
        ], "CombatSimulation.applyDamage:damage-worlds");
    /*
    功能
    读取指定条件世界中扣除免伤后的实际伤害量。

    调用方
    applyDamage 的护盾与生命投影：在每个条件世界复用同一护援减免。

    输入
    含 damageAmount 的当前伤害分支。

    输出
    扣除本次护援减免后的非负伤害量。

    读取状态
    闭包中的 aidReductionPerLifeDamage 与 preAidHpDamageFor。

    写入状态
    无。

    调用函数
    无。

    边界与不变量
    只有护援前确实存在生命伤害的世界才减少入射伤害；不得再次应用格挡或护盾减免。
    */
    const effectiveDamageFor = (branch) => Math.max(
      0,
      branch.damageAmount
        - (preAidHpDamageFor(branch) > PROBABILITY_EPSILON ? aidReductionPerLifeDamage : 0)
    );
    /*
    功能
    读取指定条件世界中穿过护盾并落到生命值的伤害量。

    调用方
    applyDamage：计算每个条件世界真正落到生命值的部分。

    输入
    含 occurs、passes、damageAmount 与 shieldAmount 的伤害分支。

    输出
    该分支的非负生命伤害量。

    读取状态
    闭包中的 effectiveDamageFor。

    写入状态
    无。

    调用函数
    effectiveDamageFor。

    边界与不变量
    未发生或未穿过响应的世界必须返回零；护盾只在这里扣一次。
    */
    const hpDamageFor = (branch) => {
      if (!branch.occurs || !branch.passes) return 0;
      const effectiveAmount = effectiveDamageFor(branch);
      const absorbed = calculateShieldAbsorption(branch.shieldAmount, effectiveAmount);
      return calculateHpDamage(effectiveAmount, absorbed);
    };
    const shieldOutcomes = this.projectProbabilityWork(damageWorlds, (branch) => ({
      amount:branch.occurs && branch.passes
        ? Math.max(
            0,
            branch.shieldAmount - calculateShieldAbsorption(
              branch.shieldAmount,
              effectiveDamageFor(branch)
            )
          )
        : branch.shieldAmount
    }), "CombatSimulation.applyDamage:shield-outcome");
    target.shield = expectedBranchValue(shieldOutcomes);
    let actualDamage = 0;
    for (let index = 0; index < damageWorlds.length; index += 1) {
      if (index % 32 === 0) this.checkpointSearchWork();
      const branch = damageWorlds[index];
      actualDamage += branch.probability * hpDamageFor(branch);
    }
    const lifeDamageBranches = this.projectProbabilityWork(damageWorlds, (branch) => ({
      occurs:hpDamageFor(branch) > PROBABILITY_EPSILON
    }), "CombatSimulation.applyDamage:life-damage");
    const lifeDamageChance = this.eventProbability(lifeDamageBranches);
    if (options.outcome) {
      options.outcome.lifeDamageBranches = lifeDamageBranches;
      options.outcome.lifeDamageChance = lifeDamageChance;
      options.outcome.blockedByCardChance = eventProbability * blockedByCardChance;
      options.outcome.remainingBlockCountBranches = attackOutcomeWorlds
        ? this.projectProbabilityWork(attackOutcomeWorlds, (branch) => ({
            remainingBlockCount:branch.requiredCount
          }), "CombatSimulation.applyDamage:remaining-blocks")
        : null;
    }
    this.commitHpOutcomeBranches(state, target, damageWorlds, hpDamageFor);
    this.simulateAfterLifeDamage(state, attacker, target, lifeDamageChance,
      lifeDamageBranches, options.damageContext ?? {});
    this.resolveFatal(state, target, attacker);
    this.simulateSpyGapAfterLifeDamage(state, attacker, target, lifeDamageChance);
    return actualDamage;
  }


  /*
  功能
  在濒死世界中按已确定救援意愿、合法资源和角色被动结算存活、死亡及资源消耗。

  调用方
  applyDamage：在目标生命不大于零时结算救援和死亡。

  输入
  独立 World、濒死目标与可空伤害来源。

  输出
  无返回值；目标存活、死亡或被救援后的状态已完成。

  读取状态
  同阵营座次、Evaluator 救援意愿、调息容量、角色被动、击杀来源与奖励配置。

  写入状态
  救援者手牌/调息/回春，目标生命与全部死亡清理字段，攻击者击杀摸牌。

  调用函数
  decideDyingRescue、consumeKnownCardsFromHand、simulateCoordination、setSimulatedEquipment、
  clearHuntMarksBySource、gainUnknownCardsWithCounterState。

  边界与不变量
  救援按目标优先再顺时针盟友顺序；死亡清理和击杀奖励最多执行一次，不产生半存活状态。
  */
  resolveFatal(state, target, attacker = null) {
    if (!isDying(target.hp, target.alive)) return;
    const need = Math.max(0, 1 - target.hp);
    const roster = projectCanonicalSeatRoster(state.players);
    const rescueOrder = getDyingRescueResponderOrder(roster, target.id);
    const allies = rescueOrder
      .map((id) => state.players.find((player) => player.id === id))
      .filter(Boolean);
    /*
    功能
    惰性查询一名救援者当前可用调息的期望容量。

    调用方
    resolveFatal 的总容量判断与逐轮救援消费。

    输入
    当前 World 中的救援玩家。

    输出
    由唯一 ProbabilityState 和确定身份牌共同得到的非负期望张数。

    读取状态
    当前 World.probabilityState 与玩家 hand/knownCards。

    写入状态
    无。

    调用函数
    queryHandProbability。

    边界与不变量
    查询结果只在本次濒死结算调用栈中存在，不写回 World，也不创建调息分支层级。
    */
    const recoverCapacity = (player) => queryHandProbability(state.probabilityState, {
      bucketId:player.id,
      knownResources:[
        ...(Array.isArray(player.hand) ? player.hand : []),
        ...(Array.isArray(player.knownCards) ? player.knownCards : [])
      ],
      definitionId:"recover"
    }).expected;
    const rescuers = [];
    for (const player of allies) {
      const available = Math.max(0, recoverCapacity(player));
      rescuers.push({
        player,
        available,
        willing:available > PROBABILITY_EPSILON && this.decideDyingRescue(
          state,
          player,
          target,
          { need, available }
        ) === true
      });
    }
    const capacity = rescuers.reduce(
      (sum, entry) => sum + (entry.willing ? entry.available : 0),
      0
    );
    if (capacity < need) {
      target.alive = false;
      target.hp = 0;
      target.exposeWeaknessStacks = 0;
      target.assaultBonus = 0;
      target.huntMarkSourceId = null;
      target.huntMarkProbability = 0;
      target.huntMarkProbabilities = {};
      target.momentum = 0;
      target.statuses = [];
      target.handCount = 0;
      target.hand = [];
      target.knownCards = [];
      const anonymousSlots = expectedAnonymousSlots(state.probabilityState, target.id);
      const wholeSlots = Math.floor(anonymousSlots);
      if (wholeSlots > 0) mutateProbability(state.probabilityState, {
        type:"REMOVE",
        sourceBucketId:target.id,
        count:wholeSlots
      });
      if (anonymousSlots - wholeSlots > PROBABILITY_EPSILON) mutateProbability(
        state.probabilityState,
        {
          type:"REMOVE",
          sourceBucketId:target.id,
          probability:anonymousSlots - wholeSlots
        }
      );
      this.setSimulatedEquipment(target, null, 0);
      this.clearHuntMarksBySource(state, target.id);
      const targetFact = roster.find((player) => player.id === target.id) ?? null;
      const attackerFact = attacker ? roster.find((player) => player.id === attacker.id) ?? null : null;
      if (isKillRewardEligible(
        { rewardGranted:false, alive:targetFact?.alive, battleTeam:targetFact?.battleTeam },
        attackerFact
      )) {
        this.gainUnknownCardsWithCounterState(
          state, attacker, RULESET_DEFINITION.killRewardDrawCount, null, "kill-reward-draw"
        );
      }
      return;
    }
    let remaining = need;
    let healingApplied = 0;
    const maxRounds = Math.max(1, Math.ceil(capacity));
    let rounds = 0;
    while (remaining > PROBABILITY_EPSILON && rounds < maxRounds) {
      let usedThisRound = false;
      for (const entry of rescuers) {
        if (remaining <= PROBABILITY_EPSILON) break;
        if (!entry.willing) continue;
        const rescuer = entry.player;
        const available = Math.max(0, recoverCapacity(rescuer));
        if (available <= PROBABILITY_EPSILON) continue;
        const canRejuvenate = hasPassiveSkill(rescuer, "rejuvenation")
          && (rescuer.rejuvenationTriggerCount ?? 0)
            < PASSIVE_SKILL_DEFINITIONS.rejuvenation.maxTriggersPerTurn;
        const healingPerCard = DOMAIN_CARD_DEFINITIONS.recover.healAmount;
        const spent = Math.min(1, available);
        if (spent <= PROBABILITY_EPSILON) continue;
        const healing = spent * healingPerCard;
        usedThisRound = true;
        remaining -= healing;
        healingApplied += healing;
        const knownBefore = (Array.isArray(rescuer.hand) ? rescuer.hand : [])
          .filter((entry) => entry.definitionId === "recover")
          .reduce((sum, entry) => sum + this.cardAvailability(entry), 0);
        this.consumeKnownCardsFromHand(state, rescuer, "recover", spent);
        const knownAfter = (Array.isArray(rescuer.hand) ? rescuer.hand : [])
          .filter((entry) => entry.definitionId === "recover")
          .reduce((sum, entry) => sum + this.cardAvailability(entry), 0);
        const anonymousSpent = Math.max(0, spent - (knownBefore - knownAfter));
        if (anonymousSpent > PROBABILITY_EPSILON) mutateProbability(state.probabilityState, {
          type:"REMOVE",
          sourceBucketId:rescuer.id,
          definitionId:"recover",
          probability:anonymousSpent
        });
        rescuer.handCount = Math.max(0, (rescuer.handCount ?? 0) - spent);
        if (canRejuvenate) {
          // 概率救援按实际消耗的期望调息推进回春：摸牌与次数消耗必须共享同一概率权重，
          // 并以每回合 2 次为上限，避免“摸牌按分数计、次数却完整消耗”的条件世界失配。
          const remainingSlots = Math.max(
            0,
            PASSIVE_SKILL_DEFINITIONS.rejuvenation.maxTriggersPerTurn
              - (rescuer.rejuvenationTriggerCount ?? 0)
          );
          const consume = Math.min(spent, remainingSlots);
          if (consume > PROBABILITY_EPSILON) {
            this.gainUnknownCardsWithCounterState(state, rescuer, consume, null, "rejuvenation-rescue-draw");
            rescuer.rejuvenationTriggerCount = (rescuer.rejuvenationTriggerCount ?? 0) + consume;
          }
        }
        this.simulateCoordination(state, rescuer, [target], spent);
      }
      rounds += 1;
      if (!usedThisRound) break;
    }
    const appliedHealing = calculateHealAmount(healingApplied, target.maxHp, target.hp);
    target.hp += appliedHealing;
    target.alive = true;
  }

  /*
  功能
  将确定治疗量写入目标生命值分支并限制在最大生命值内。

  调用方
  healFrom 与直接治疗镜像：只推进确定生命恢复。

  输入
  目标玩家与正治疗量。

  输出
  无返回值；目标 hp 可能增加。

  读取状态
  目标 alive、hp 与 maxHp。

  写入状态
  仅目标 hp。

  调用函数
  无。

  边界与不变量
  死亡或已满生命目标不变化；生命不得超过 maxHp。
  */
  heal(target, amount) {
    if (!target.alive || amount <= 0) return;
    const applied = calculateHealAmount(amount, target.maxHp, target.hp);
    if (applied > 0) target.hp += applied;
  }

  /*
  功能
  结算带来源的治疗，同时推进与治疗来源和目标相关的角色被动。

  调用方
  CardEffectSimulation 与 SkillEffectSimulation：结算带来源的治疗及回春被动。

  输入
  独立 World、治疗来源、存活目标与正治疗量。

  输出
  无返回值；治疗和可能的回春摸牌已结算。

  读取状态
  治疗前后生命、来源角色/阵营与回春次数。

  写入状态
  目标 hp；满足条件时写来源回春次数、手牌与响应摘要。

  调用函数
  heal、gainUnknownCardsWithCounterState。

  边界与不变量
  回春只按实际治疗量触发且每回合不超过两次；摸牌与次数消费共享同一概率权重。
  */
  healFrom(state, source, target, amount) {
    if (!target?.alive || target.hp >= target.maxHp || amount <= 0) return;
    const beforeHp = target.hp;
    this.heal(target, amount);
    const actualAmount = Math.max(0, target.hp - beforeHp);
    if (hasPassiveSkill(source, "rejuvenation") && source.battleTeam === target.battleTeam
      && (source.rejuvenationTriggerCount ?? 0)
        < PASSIVE_SKILL_DEFINITIONS.rejuvenation.maxTriggersPerTurn) {
      const triggerWeight = Math.min(1, actualAmount);
      if (triggerWeight <= PROBABILITY_EPSILON) return;
      // 概率执行的治疗只按触发权重推进回春次数，与摸牌共享同一概率权重；
      // 剩余额度按 2 - 期望次数截断，保证期望次数不越过每回合 2 次上限。
      const remainingSlots = Math.max(
        0,
        PASSIVE_SKILL_DEFINITIONS.rejuvenation.maxTriggersPerTurn
          - (source.rejuvenationTriggerCount ?? 0)
      );
      const consume = Math.min(triggerWeight, remainingSlots);
      if (consume <= PROBABILITY_EPSILON) return;
      source.rejuvenationTriggerCount = (source.rejuvenationTriggerCount ?? 0) + consume;
      this.gainUnknownCardsWithCounterState(state, source, consume, null, "rejuvenation-draw");
    }
  }
};
