/*
模块职责
执行已解析伤害的护盾、生命、HP/alive 分支与直接治疗 primitive。

上游
Simulator 正式模拟门面。

下游
Domain Combat Rules 与 canonical Probability facade。

状态边界
只修改 Simulator 门面提供的独立 World 副本，不持有真实 GameState。

信息边界
只消费已解析 damage worlds 与合法概率摘要，不读取隐藏实体牌或未来牌堆。

架构约束
不得拥有 Block/Counter/Guardian、资源支付或跨子系统生命周期编排。
*/
import {
  calculateHealAmount,
  calculateHpDamage,
  calculateShieldAbsorption
} from "../../domain/rules/combat/CombatRules.js";
import {
  PROBABILITY_CLASSIFICATION,
  PROBABILITY_EPSILON,
  expectedBranchValue,
  queryHandProbability
} from "../Event/Probability/Probability.js";

/*
功能
把 Base class 与已解析 Damage primitive 组合成单一 Simulator 类型。

调用方
Simulator.js 文件末尾的组合表达式。

输入
已经包含共享概率运行时的 Base class；传入的是类定义，不是搜索节点实例。

输出
继承 Base 并新增 HP、护盾和治疗 primitive 的 class 定义；不创建 Simulator 实例。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
只在模块加载时组合一次；本 sibling 不得调用 Resource 或 Response capability。
*/
export const withDamage = (Base) => class Damage extends Base {
  /*
  功能
  把伤害条件世界投影为 HP/存活分支，并明确标记标量 HP 是否只是期望摘要。

  调用方
  applyResolvedDamage 在护盾和实际生命伤害确定后。

  输入
  World、目标、伤害世界与逐世界生命伤害查询。

  输出
  只在本次伤害调用栈存在的 hp/alive 结果分区。

  读取状态
  目标既有 HP 分支与同阵营调息期望容量。

  写入状态
  hpSummaryClassification、aliveProbability、待 fatal 结算的 alive 标量与 hp 摘要。

  调用函数
  queryHandProbability 与 SimulatorCore 概率投影 primitive。

  边界与不变量
  无救援容量时死亡边界按每个世界离散结算；exact lethal 的标量 alive 在本次调用栈中
  必须暂时保持 true，交由随后的 resolveFatal 唯一执行资源清理与击杀奖励；
  绝不把跨边界的 expected HP 宣称为确定状态。
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
    }, "Damage.commitHpOutcomeBranches:project");
    const distinct = new Set();
    let aliveProbability = 0;
    let expectedHp = 0;
    let hasFatalOutcome = false;
    for (let index = 0; index < branches.length; index += 1) {
      if (index % 32 === 0) this.checkpointSearchWork();
      const branch = branches[index];
      distinct.add(`${branch.hp}|${branch.alive}`);
      if (branch.alive) aliveProbability += branch.probability;
      else hasFatalOutcome = true;
      expectedHp += branch.hp * branch.probability;
    }
    target.hpSummaryClassification = distinct.size > 1
      ? PROBABILITY_CLASSIFICATION.EXPECTED_VALUE
      : PROBABILITY_CLASSIFICATION.EXACT;
    target.aliveProbability = aliveProbability;
    target.alive = aliveProbability > PROBABILITY_EPSILON || hasFatalOutcome;
    target.hp = expectedHp;
    return branches;
  }

  /*
  功能
  对已经通过 Block 和 Guardian 的条件世界执行 Shield、HP 与伤害结果构造。

  调用方
  Simulator.applyDamage：所有响应结果与 mitigation 已解析后。

  输入
  World、目标、damage worlds、每个 pending HP world 的 Guardian 减免量与结果上下文。

  输出
  actualDamage、lifeDamageChance 和 lifeDamageBranches 的局部结果对象。

  读取状态
  已解析 damageAmount、shieldAmount、occurs/passes 与目标当前 HP。

  写入状态
  目标 shield、HP/alive 分支及调用方 outcome 的 damage fields。

  调用函数
  calculateShieldAbsorption、calculateHpDamage、commitHpOutcomeBranches 与概率投影 primitive。

  边界与不变量
  不重新决定或支付任何响应；Guardian 只在原本存在 pending HP damage 的世界减免，
  Shield 先于 HP 且两者各提交一次。
  */
  applyResolvedDamage(
    state,
    target,
    damageWorlds,
    aidReductionPerLifeDamage,
    resolution = {}
  ) {
    /*
    功能
    读取 Guardian 减免前穿过 Shield 的 HP damage。

    调用方
    applyResolvedDamage 的减免适用条件。

    输入
    含 occurs、passes、shieldAmount 与 damageAmount 的 resolved branch。

    输出
    非负 HP damage。

    读取状态
    无。

    写入状态
    无。

    调用函数
    calculateShieldAbsorption、calculateHpDamage。

    边界与不变量
    未发生或未通过响应的世界固定返回零，不提交 Shield 或 HP。
    */
    const preAidHpDamageFor = (branch) => {
      if (!branch.occurs || !branch.passes) return 0;
      const absorbed = calculateShieldAbsorption(branch.shieldAmount, branch.damageAmount);
      return calculateHpDamage(branch.damageAmount, absorbed);
    };
    /*
    功能
    将已解析 Guardian mitigation 应用到仍有 pending HP damage 的世界。

    调用方
    applyResolvedDamage 的 Shield 与 HP 投影。

    输入
    resolved damage branch。

    输出
    Guardian 后的非负入射 damageAmount。

    读取状态
    闭包 aidReductionPerLifeDamage。

    写入状态
    无。

    调用函数
    preAidHpDamageFor。

    边界与不变量
    Guardian 不得减少原本不会穿过 Shield 的世界，也不得重复减免。
    */
    const effectiveDamageFor = (branch) => Math.max(
      0,
      branch.damageAmount
        - (preAidHpDamageFor(branch) > PROBABILITY_EPSILON ? aidReductionPerLifeDamage : 0)
    );
    /*
    功能
    读取 resolved branch 在 Guardian 与 Shield 后落到 HP 的伤害量。

    调用方
    applyResolvedDamage 的 HP branch、lifeDamageChance 与结果构造。

    输入
    resolved damage branch。

    输出
    非负 HP damage。

    读取状态
    无。

    写入状态
    无。

    调用函数
    effectiveDamageFor、calculateShieldAbsorption、calculateHpDamage。

    边界与不变量
    Shield 只在此扣除一次；未发生或未通过响应的世界返回零。
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
    }), "Damage.applyDamage:shield-outcome");
    target.shield = expectedBranchValue(shieldOutcomes);
    let actualDamage = 0;
    for (let index = 0; index < damageWorlds.length; index += 1) {
      if (index % 32 === 0) this.checkpointSearchWork();
      const branch = damageWorlds[index];
      actualDamage += branch.probability * hpDamageFor(branch);
    }
    const lifeDamageBranches = this.projectProbabilityWork(damageWorlds, (branch) => ({
      occurs:hpDamageFor(branch) > PROBABILITY_EPSILON
    }), "Damage.applyDamage:life-damage");
    const lifeDamageChance = this.eventProbability(lifeDamageBranches);
    if (resolution.outcome) {
      resolution.outcome.lifeDamageBranches = lifeDamageBranches;
      resolution.outcome.lifeDamageChance = lifeDamageChance;
      resolution.outcome.blockedByCardChance = resolution.eventProbability
        * resolution.blockedByCardChance;
      resolution.outcome.remainingBlockCountBranches = resolution.attackOutcomeWorlds
        ? this.projectProbabilityWork(resolution.attackOutcomeWorlds, (branch) => ({
            remainingBlockCount:branch.requiredCount
          }), "Damage.applyDamage:remaining-blocks")
        : null;
    }
    this.commitHpOutcomeBranches(state, target, damageWorlds, hpDamageFor);
    return { actualDamage, lifeDamageChance, lifeDamageBranches };
  }

  /*
  功能
  将确定治疗量写入目标生命值并限制在最大生命值内。

  调用方
  Simulator.healFrom 与直接治疗专项测试。

  输入
  目标玩家与正治疗量。

  输出
  无返回值；目标 hp 可能增加。

  读取状态
  目标 alive、hp 与 maxHp。

  写入状态
  仅目标 hp。

  调用函数
  calculateHealAmount。

  边界与不变量
  死亡或已满生命目标不变化；生命不得超过 maxHp。
  */
  heal(target, amount) {
    if (!target.alive || amount <= 0) return;
    const applied = calculateHealAmount(amount, target.maxHp, target.hp);
    if (applied > 0) target.hp += applied;
  }
};
