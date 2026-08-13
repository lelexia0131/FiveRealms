/**
 * 刃行者专项矩阵：验证破军的可兑现攻击容量、连势的获得/保留/兑现、
 * 防御与击杀阈值，以及多目标和多步行动顺序。评分只认真实动作链，
 * 不把“更常发动技能”当成正确行为。
 */
import { registerScenario } from "../benchmark.mjs";
import { makeCard } from "../helpers.mjs";
import {
  QUALITY, isCard, isEnd, isSkill, quality, targetsOnly, describeActionShort
} from "../evaluators/scenarioDsl.mjs";

const BASE = [
  { id:"a", team:"dawn", general:"blade-walker" },
  { id:"b", team:"dusk", general:"oath-warden" },
  { id:"c", team:"dusk", general:"fate-gambler" },
  { id:"d", team:"dawn", general:"spirit-medic" },
  { id:"e", team:"dusk", general:"ember-magus" }
];

function board(actorOverrides = {}, others = {}, seed = 81000) {
  const players = BASE.map((config) => ({
    ...config,
    hp:4,
    energy:1,
    hand:[]
  }));
  const actor = players[0];
  Object.assign(actor, {
    energy:2,
    hand:[],
    turnFlags:{},
    statuses:{}
  }, actorOverrides);
  for (const player of players.slice(1)) Object.assign(player, others[player.id] ?? {});
  return { players, options:{ actorId:"a", seed } };
}

const sequenceCardCount = (stats, definitionId) => (stats?.bestSequence ?? [])
  .filter((action) => action.cardId === definitionId).length;
const sequenceHasSkill = (stats, skillId) => (stats?.bestSequence ?? [])
  .some((action) => action.type === "skill" && action.cardId === skillId);

registerScenario({
  id:"blade.break-army-no-assault",
  name:"刃行者专项：无突袭不发动破军",
  category:"basicSkills",
  depth:1,
  setup:() => board({ energy:2, hand:[] }),
  grade:({ action, legalActions }) => {
    if (legalActions.some((entry) => isSkill(entry, "breakArmy"))) {
      return quality(QUALITY.CATASTROPHIC, "无突袭时仍生成破军");
    }
    if (isEnd(action)) return quality(QUALITY.OPTIMAL, "无可兑现攻击，正确结束");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id:"blade.break-army-one-card-one-slot",
  name:"刃行者专项：一张突袭与一个现成次数不浪费破军",
  category:"resources",
  depth:2,
  setup:() => board({
    energy:2,
    hand:[makeCard("assault")],
    turnFlags:{ attackUsed:1, attackLimit:2 }
  }, { b:{ hp:3 } }),
  grade:({ action, legalActions }) => {
    if (legalActions.some((entry) => isSkill(entry, "breakArmy"))) {
      return quality(QUALITY.CATASTROPHIC, "现成次数足够时仍生成无可兑现容量的破军");
    }
    if (isCard(action, "assault") || isEnd(action)) {
      return quality(QUALITY.OPTIMAL, "没有额外容量可兑现，正确排除破军");
    }
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id:"blade.break-army-extra-capacity-chain",
  name:"刃行者专项：两张突袭只剩一次时兑现破军容量",
  category:"planning",
  depth:4,
  difficulty:"advanced",
  discrimination:"planning",
  setup:() => board({
    energy:2,
    hand:[makeCard("assault"), makeCard("assault")],
    turnFlags:{ attackUsed:1, attackLimit:2 }
  }),
  grade:({ action, stats }) => {
    const completeChain = sequenceHasSkill(stats, "breakArmy")
      && sequenceCardCount(stats, "assault") === 2;
    if (completeChain && (isCard(action, "assault") || isSkill(action, "breakArmy"))) {
      return quality(QUALITY.OPTIMAL, "实际计划包含破军新增槽与两次突袭");
    }
    if (isCard(action, "assault") || isSkill(action, "breakArmy")) {
      return quality(QUALITY.POOR, "找到进攻但没有兑现完整新增容量");
    }
    return quality(QUALITY.SEVERE, `放弃可兑现破军链：${describeActionShort(action)}`);
  }
});

registerScenario({
  id:"blade.break-army-after-slots-spent",
  name:"刃行者专项：普通次数耗尽后破军再突袭",
  category:"planning",
  depth:2,
  difficulty:"intermediate",
  discrimination:"planning",
  setup:() => board({
    energy:2,
    hand:[makeCard("assault")],
    turnFlags:{ attackUsed:2, attackLimit:2 }
  }, { b:{ hp:1 } }),
  grade:({ action, stats }) => {
    if (isSkill(action, "breakArmy") && sequenceCardCount(stats, "assault") === 1) {
      return quality(QUALITY.OPTIMAL, "破军新增槽在下一层允许突袭");
    }
    return quality(QUALITY.SEVERE, `未发现破军→突袭：${describeActionShort(action)}`);
  }
});

registerScenario({
  id:"blade.break-army-insufficient-energy",
  name:"刃行者专项：能量不足不生成破军",
  category:"basicRules",
  depth:1,
  setup:() => board({
    energy:1,
    hand:[makeCard("assault"), makeCard("assault")],
    turnFlags:{ attackUsed:1, attackLimit:2 }
  }),
  grade:({ action, legalActions }) => {
    if (legalActions.some((entry) => isSkill(entry, "breakArmy"))) {
      return quality(QUALITY.CATASTROPHIC, "能量不足仍生成破军");
    }
    if (isCard(action, "assault")) return quality(QUALITY.OPTIMAL, "使用仍合法的普通突袭");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id:"blade.break-army-use-limit",
  name:"刃行者专项：破军次数耗尽不重复生成",
  category:"basicRules",
  depth:1,
  setup:() => board({
    energy:2,
    hand:[makeCard("assault"), makeCard("assault")],
    turnFlags:{
      attackUsed:1,
      attackLimit:2,
      activeSkillUseCounts:{ breakArmy:1 },
      activeSkillsUsed:new Set(["breakArmy"])
    }
  }),
  grade:({ action, legalActions }) => {
    if (legalActions.some((entry) => isSkill(entry, "breakArmy"))) {
      return quality(QUALITY.CATASTROPHIC, "次数耗尽仍生成破军");
    }
    if (isCard(action, "assault")) return quality(QUALITY.OPTIMAL, "继续使用合法突袭");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id:"blade.momentum-new-category-lethal",
  name:"刃行者专项：新类别叠连势后跨过击杀线",
  category:"combos",
  depth:3,
  difficulty:"advanced",
  discrimination:"planning",
  setup:() => board({
    energy:2,
    hand:[makeCard("exposeWeakness"), makeCard("assault")],
    turnFlags:{ momentum:1, categoriesUsed:new Set(["basic"]), attackUsed:1, attackLimit:2 }
  }, { b:{ hp:4 } }),
  grade:({ action, stats }) => {
    if (isCard(action, "exposeWeakness") && stats?.bestSequence?.[1]?.cardId === "assault") {
      return quality(QUALITY.OPTIMAL, "战术首次使用叠至2层并由后续突袭兑现");
    }
    if (isCard(action, "assault")) return quality(QUALITY.SEVERE, "直接突袭未跨过4HP击杀线");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id:"blade.momentum-expiry-no-garbage-assault",
  name:"刃行者专项：连势到期也不强打纯护盾目标",
  category:"resources",
  depth:2,
  difficulty:"advanced",
  discrimination:"resource",
  setup:() => board({
    energy:2,
    hand:[makeCard("assault")],
    turnFlags:{ momentum:2, categoriesUsed:new Set(["basic"]), attackUsed:1, attackLimit:2 }
  }, { b:{ shield:3 }, e:{ shield:3 } }),
  grade:({ action }) => {
    if (isEnd(action)) return quality(QUALITY.OPTIMAL, "连势是沉没的到期选择权，不强迫零生命收益攻击");
    if (isCard(action, "assault")) return quality(QUALITY.SEVERE, "为了避免连势清空而浪费突袭");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id:"blade.momentum-multi-target-threshold",
  name:"刃行者专项：强化突袭给2HP而普通突袭收1HP",
  category:"board",
  depth:3,
  difficulty:"advanced",
  discrimination:"planning",
  setup:() => board({
    energy:2,
    hand:[makeCard("assault"), makeCard("assault")],
    turnFlags:{ momentum:1, categoriesUsed:new Set(["basic"]), attackUsed:0, attackLimit:2 }
  }, { b:{ hp:1 }, e:{ hp:2 } }),
  grade:({ action, stats }) => {
    const targets = (stats?.bestSequence ?? [])
      .filter((entry) => entry.cardId === "assault")
      .map((entry) => entry.targetId);
    if (isCard(action, "assault") && targets[0] === "e" && targets[1] === "b") {
      return quality(QUALITY.OPTIMAL, "强化击杀2HP目标，第二次普通攻击收掉1HP目标");
    }
    if (isCard(action, "assault") && targets[0] === "b") {
      return quality(QUALITY.SEVERE, "强化伤害溢出在1HP目标");
    }
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id:"blade.momentum-block-target-choice",
  name:"刃行者专项：强化突袭避开已知格挡目标",
  category:"probability",
  depth:2,
  difficulty:"advanced",
  discrimination:"probability",
  setup:() => {
    const knownBlock = makeCard("block", "known-block");
    return board({
      energy:2,
      hand:[makeCard("assault")],
      aiMemory:{ knownCardsByPlayer:{ b:[knownBlock] } },
      turnFlags:{ momentum:2, categoriesUsed:new Set(["basic"]), attackUsed:1, attackLimit:2 }
    }, {
      b:{ hp:3, hand:[knownBlock] },
      e:{ hp:3 }
    });
  },
  grade:({ action }) => {
    if (isCard(action, "assault") && targetsOnly(action, "e")) {
      return quality(QUALITY.OPTIMAL, "把强化伤害用于无格挡的稳定3HP目标");
    }
    if (isCard(action, "assault") && targetsOnly(action, "b")) {
      return quality(QUALITY.SEVERE, "已知格挡会保留连势但浪费本回合攻击机会");
    }
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id:"blade.momentum-radar-target-choice",
  name:"刃行者专项：雷达降低强化突袭目标价值",
  category:"probability",
  depth:2,
  difficulty:"advanced",
  discrimination:"probability",
  setup:() => board({
    energy:2,
    hand:[makeCard("assault")],
    turnFlags:{ momentum:2, categoriesUsed:new Set(["basic"]), attackUsed:1, attackLimit:2 }
  }, {
    b:{ hp:3, equipment:makeCard("defenseDevice") },
    e:{ hp:3 }
  }),
  grade:({ action }) => {
    if (isCard(action, "assault") && targetsOnly(action, "e")) {
      return quality(QUALITY.OPTIMAL, "选择无雷达的稳定3HP目标");
    }
    if (isCard(action, "assault") && targetsOnly(action, "b")) {
      return quality(QUALITY.SEVERE, "忽略公开雷达免疫与得牌分支");
    }
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id:"blade.momentum-battle-device-threshold",
  name:"刃行者专项：军火库改变格挡后的击杀目标",
  category:"probability",
  depth:2,
  difficulty:"advanced",
  discrimination:"probability",
  setup:() => {
    const knownBlock = makeCard("block", "known-block");
    return board({
      energy:2,
      equipment:makeCard("battleDevice"),
      hand:[makeCard("assault")],
      aiMemory:{ knownCardsByPlayer:{ b:[knownBlock] } },
      turnFlags:{ momentum:1, categoriesUsed:new Set(["basic"]), attackUsed:1, attackLimit:2 }
    }, {
      b:{ hp:2, hand:[knownBlock] },
      e:{ hp:3 }
    });
  },
  grade:({ action }) => {
    if (isCard(action, "assault") && targetsOnly(action, "b")) {
      return quality(QUALITY.OPTIMAL, "军火库要求两张格挡，已知单格挡无法阻止2点击杀");
    }
    return quality(QUALITY.POOR, `未利用军火库改变的防御阈值：${describeActionShort(action)}`);
  }
});

registerScenario({
  id:"blade.momentum-guardian-target-choice",
  name:"刃行者专项：强化突袭避开护援覆盖目标",
  category:"board",
  depth:2,
  difficulty:"advanced",
  discrimination:"planning",
  setup:() => {
    const guardianCard = makeCard("charge", "guardian-card");
    return board({
      energy:2,
      equipment:makeCard("telescope"),
      hand:[makeCard("assault")],
      aiMemory:{ knownCardsByPlayer:{ c:[guardianCard] } },
      turnFlags:{ momentum:1, categoriesUsed:new Set(["basic"]), attackUsed:1, attackLimit:2 }
    }, {
      b:{ hp:2 },
      c:{ general:"oath-warden", hp:2, hand:[guardianCard] },
      e:{ hp:4 }
    });
  },
  grade:({ action }) => {
    if (isCard(action, "assault") && targetsOnly(action, "c")) {
      return quality(QUALITY.OPTIMAL, "攻击守誓者本人不触发其护援，稳定跨过2HP阈值");
    }
    if (isCard(action, "assault") && targetsOnly(action, "b")) {
      return quality(QUALITY.SEVERE, "攻击受护援保护的2HP目标无法稳定兑现生命伤害");
    }
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id:"blade.momentum-dynamic-distance-chain",
  name:"刃行者专项：击杀后动态距离开放第二目标",
  category:"board",
  depth:3,
  difficulty:"advanced",
  discrimination:"planning",
  setup:() => board({
    energy:2,
    hand:[makeCard("assault"), makeCard("assault")],
    turnFlags:{ attackUsed:0, attackLimit:2 }
  }, {
    b:{ hp:1 },
    c:{ hp:1 },
    e:{ shield:3 }
  }),
  grade:({ action, stats }) => {
    const targets = (stats?.bestSequence ?? [])
      .filter((entry) => entry.cardId === "assault")
      .map((entry) => entry.targetId);
    if (isCard(action, "assault") && targets[0] === "b" && targets[1] === "c"
      && stats?.discoveredDynamicTarget) {
      return quality(QUALITY.OPTIMAL, "先击杀相邻目标，再攻击进入距离的新目标");
    }
    return quality(QUALITY.POOR, `未利用阵亡后的动态距离：${describeActionShort(action)}`);
  }
});

registerScenario({
  id:"blade.momentum-rescue-overcome-with-expose",
  name:"刃行者专项：破势跨过已知调息救援阈值",
  category:"board",
  depth:2,
  difficulty:"advanced",
  discrimination:"planning",
  setup:() => {
    const recover = makeCard("recover", "known-recover");
    return board({
      energy:2,
      hand:[makeCard("exposeWeakness"), makeCard("assault")],
      aiMemory:{ knownCardsByPlayer:{ c:[recover] } },
      turnFlags:{
        categoriesUsed:new Set(["basic", "tactic"]),
        attackUsed:1,
        attackLimit:2
      }
    }, {
      b:{ hp:1 },
      c:{ hand:[recover] },
      e:{ shield:3 }
    });
  },
  grade:({ action, stats }) => {
    if (isCard(action, "exposeWeakness")
      && stats?.bestSequence?.[1]?.cardId === "assault"
      && stats.bestSequence[1].targetId === "b") {
      return quality(QUALITY.OPTIMAL, "破势使伤害超过敌方唯一已知调息的救援能力");
    }
    if (isCard(action, "assault") && targetsOnly(action, "b")) {
      return quality(QUALITY.SEVERE, "直接突袭会被敌方队友的已知调息救回");
    }
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id:"blade.full-chain-break-momentum-expose",
  name:"刃行者专项：破军、连势、破势与两次突袭完整链",
  category:"planning",
  depth:4,
  difficulty:"expert",
  discrimination:"planning",
  setup:() => board({
    energy:2,
    hand:[makeCard("assault"), makeCard("assault"), makeCard("exposeWeakness")],
    turnFlags:{ momentum:2, categoriesUsed:new Set(["basic"]), attackUsed:1, attackLimit:2 }
  }, { b:{ hp:3 }, e:{ hp:2 } }),
  grade:({ action, stats }) => {
    const sequence = stats?.bestSequence ?? [];
    const complete = sequenceHasSkill(stats, "breakArmy")
      && sequenceCardCount(stats, "assault") === 2
      && sequenceCardCount(stats, "exposeWeakness") === 1;
    if (complete && (isCard(action, "assault") || isCard(action, "exposeWeakness")
      || isSkill(action, "breakArmy"))) {
      return quality(QUALITY.OPTIMAL, "真实四步链分别消费连势、破势与破军新增次数");
    }
    return quality(QUALITY.POOR, `未发现完整角色链：${describeActionShort(action)}`);
  }
});
