/**
 * 守誓者专项矩阵：验证壁垒把护盾投放到真实高风险目标（暴露感知、濒死/阵亡规避、
 * 自身最高风险、已有盾不机械堆），以及护援额度与能量的保留（无威胁不花能量、
 * 能量不足/次数耗尽不生成、队友可格挡不重复防御）。评分只认真实动作链，
 * 不把"更常发动壁垒"当成正确行为。
 */
import { registerScenario } from "../benchmark.mjs";
import { makeCard } from "../helpers.mjs";
import {
  QUALITY, isCard, isEnd, isSkill, quality, targetsOnly, describeActionShort
} from "../evaluators/scenarioDsl.mjs";

const BASE = [
  { id:"a", team:"dawn", character:"oath-warden" },
  { id:"b", team:"dawn", character:"spirit-medic" },
  { id:"c", team:"dusk", character:"trail-hunter" },
  { id:"d", team:"dawn", character:"fate-gambler" },
  { id:"e", team:"dusk", character:"ember-magus" }
];

function board(actorOverrides = {}, others = {}, seed = 82000) {
  const players = BASE.map((config) => ({
    ...config,
    hp:4,
    energy:0,
    hand:[]
  }));
  const actor = players[0];
  Object.assign(actor, {
    energy:2,
    hand:[],
    turnFlags:{},
    statuses:{},
    aiMemory:{ knownCardsByPlayer:{} }
  }, actorOverrides);
  for (const player of players.slice(1)) Object.assign(player, others[player.id] ?? {});
  return { players, options:{ actorId:"a", seed } };
}

/** 让 AI 已知某敌方持有一张突袭，形成确定暴露（不依赖剩余牌密度）。 */
function knownAssault(ownerId) {
  const card = makeCard("assault", `known-assault-${ownerId}`);
  return { card, memory:{ [ownerId]: [card] } };
}

const barrierTo = (action, targetId) => isSkill(action, "barrier") && targetsOnly(action, targetId);

registerScenario({
  id:"oath.barrier-protect-exposed-dying",
  name:"守誓者专项：壁垒保护将受攻击的1HP队友",
  category:"board",
  depth:2,
  setup:() => {
    const threat = knownAssault("c");
    return board(
      { energy:2, aiMemory:{ knownCardsByPlayer:threat.memory } },
      { b:{ hp:1 }, c:{ hand:[threat.card] } }
    );
  },
  grade:({ action }) => {
    if (barrierTo(action, "b")) return quality(QUALITY.OPTIMAL, "护盾保护暴露的1HP队友");
    if (isSkill(action, "barrier")) return quality(QUALITY.SEVERE, "护盾投放到错误目标");
    return quality(QUALITY.POOR, `未保护濒死队友：${describeActionShort(action)}`);
  }
});

registerScenario({
  id:"oath.barrier-exposed-over-safe-lowhp",
  name:"守誓者专项：壁垒选高暴露中血目标而非安全低血目标",
  category:"board",
  depth:2,
  difficulty:"advanced",
  discrimination:"planning",
  setup:() => {
    const threat = knownAssault("e");
    return board(
      { energy:2, aiMemory:{ knownCardsByPlayer:threat.memory } },
      { b:{ hp:1 }, d:{ hp:2 }, e:{ hand:[threat.card] } }
    );
  },
  grade:({ action }) => {
    if (barrierTo(action, "d")) return quality(QUALITY.OPTIMAL, "护盾投向暴露的2HP目标而非安全1HP目标");
    if (barrierTo(action, "b")) return quality(QUALITY.SEVERE, "按低血机械选择，忽略真实暴露");
    return quality(QUALITY.POOR, `未选真实高风险目标：${describeActionShort(action)}`);
  }
});

registerScenario({
  id:"oath.barrier-self-highest-risk",
  name:"守誓者专项：自身是最高风险时对自己壁垒",
  category:"board",
  depth:2,
  difficulty:"advanced",
  discrimination:"planning",
  setup:() => {
    const threat = knownAssault("e");
    return board(
      { hp:1, energy:2, aiMemory:{ knownCardsByPlayer:threat.memory } },
      { b:{ hp:4 }, d:{ hp:4 }, e:{ hand:[threat.card] } }
    );
  },
  grade:({ action }) => {
    if (barrierTo(action, "a")) return quality(QUALITY.OPTIMAL, "自身濒死且暴露，正确对自己壁垒");
    if (isSkill(action, "barrier")) return quality(QUALITY.SEVERE, "自身最高风险却护盾给他人");
    return quality(QUALITY.POOR, `未保护自身：${describeActionShort(action)}`);
  }
});

registerScenario({
  id:"oath.barrier-no-stack-shielded",
  name:"守誓者专项：已有足量盾不机械继续堆盾",
  category:"resources",
  depth:2,
  difficulty:"advanced",
  discrimination:"resource",
  setup:() => {
    const threat = knownAssault("c");
    return board(
      { energy:2, aiMemory:{ knownCardsByPlayer:threat.memory } },
      { b:{ hp:1, shield:0 }, d:{ hp:2, shield:3 }, c:{ hand:[threat.card] } }
    );
  },
  grade:({ action }) => {
    if (barrierTo(action, "b")) return quality(QUALITY.OPTIMAL, "护盾投向0盾濒死队友，而非已有3盾目标");
    if (barrierTo(action, "d")) return quality(QUALITY.SEVERE, "机械继续给已有3盾目标堆盾");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id:"oath.barrier-dying-over-shielded",
  name:"守誓者专项：0盾濒死目标优先于3盾目标",
  category:"board",
  depth:2,
  difficulty:"advanced",
  discrimination:"planning",
  setup:() => {
    const threatC = knownAssault("c");
    const threatE = knownAssault("e");
    return board(
      {
        energy:2,
        aiMemory:{ knownCardsByPlayer:{ ...threatC.memory, ...threatE.memory } }
      },
      { b:{ hp:1, shield:0 }, d:{ hp:2, shield:3 }, c:{ hand:[threatC.card] }, e:{ hand:[threatE.card] } }
    );
  },
  grade:({ action }) => {
    if (barrierTo(action, "b")) return quality(QUALITY.OPTIMAL, "护盾给0盾濒死目标，而非已有3盾目标");
    if (barrierTo(action, "d")) return quality(QUALITY.SEVERE, "边际价值判断错误：给3盾目标");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id:"oath.barrier-two-risks-allocate",
  name:"守誓者专项：两名队友风险不同时壁垒给更高风险者",
  category:"planning",
  depth:2,
  difficulty:"advanced",
  discrimination:"planning",
  setup:() => {
    const threat = knownAssault("e");
    return board(
      { energy:2, aiMemory:{ knownCardsByPlayer:threat.memory } },
      { b:{ hp:4 }, d:{ hp:1 }, e:{ hand:[threat.card] } }
    );
  },
  grade:({ action }) => {
    if (barrierTo(action, "d")) return quality(QUALITY.OPTIMAL, "护盾给濒死的d，而非健康的b");
    if (barrierTo(action, "b")) return quality(QUALITY.SEVERE, "资源投放到低风险目标");
    return quality(QUALITY.POOR, `资源分配错误：${describeActionShort(action)}`);
  }
});

registerScenario({
  id:"oath.barrier-prefer-lethal-over-barrier",
  name:"守誓者专项：有必杀目标时不优先壁垒",
  category:"board",
  depth:2,
  difficulty:"advanced",
  discrimination:"planning",
  setup:() => {
    const threat = knownAssault("c");
    return board(
      {
        energy:2,
        hand:[makeCard("assault", "actor-assault")],
        aiMemory:{ knownCardsByPlayer:threat.memory }
      },
      { b:{ hp:1 }, c:{ hand:[threat.card] }, e:{ hp:1 } }
    );
  },
  grade:({ action }) => {
    if (isCard(action, "assault") && targetsOnly(action, "e")) return quality(QUALITY.OPTIMAL, "优先击杀1HP敌人而非壁垒");
    if (barrierTo(action, "b")) return quality(QUALITY.SEVERE, "过度防御，放弃必杀");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id:"oath.barrier-no-threat",
  name:"守誓者专项：无实际威胁时不花能量壁垒",
  category:"resources",
  depth:2,
  difficulty:"advanced",
  discrimination:"resource",
  setup:() => board({ energy:2 }, { b:{ hp:1 }, d:{ hp:1 } }),
  grade:({ action }) => {
    if (isEnd(action)) return quality(QUALITY.OPTIMAL, "无威胁时保留能量");
    if (isSkill(action, "barrier")) return quality(QUALITY.SEVERE, "无威胁仍花能量壁垒");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id:"oath.barrier-insufficient-energy",
  name:"守誓者专项：能量不足不生成壁垒",
  category:"basicRules",
  depth:1,
  setup:() => {
    const threat = knownAssault("c");
    return board(
      { energy:1, aiMemory:{ knownCardsByPlayer:threat.memory } },
      { b:{ hp:1 }, c:{ hand:[threat.card] } }
    );
  },
  grade:({ action, legalActions }) => {
    if (legalActions.some((entry) => isSkill(entry, "barrier"))) {
      return quality(QUALITY.CATASTROPHIC, "能量不足仍生成壁垒");
    }
    if (isEnd(action)) return quality(QUALITY.OPTIMAL, "能量不足正确结束");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id:"oath.barrier-use-limit",
  name:"守誓者专项：壁垒次数耗尽不重复生成",
  category:"basicRules",
  depth:1,
  setup:() => {
    const threat = knownAssault("c");
    return board(
      {
        energy:2,
        aiMemory:{ knownCardsByPlayer:threat.memory },
        turnFlags:{ activeSkillUseCounts:{ barrier:2 }, activeSkillsUsed:new Set(["barrier"]) }
      },
      { b:{ hp:1 }, c:{ hand:[threat.card] } }
    );
  },
  grade:({ action, legalActions }) => {
    if (legalActions.some((entry) => isSkill(entry, "barrier"))) {
      return quality(QUALITY.CATASTROPHIC, "次数耗尽仍生成壁垒");
    }
    if (isEnd(action)) return quality(QUALITY.OPTIMAL, "次数耗尽正确结束");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id:"oath.barrier-ally-over-safe-self",
  name:"守誓者专项：自身安全时壁垒给暴露队友而非自己",
  category:"board",
  depth:2,
  difficulty:"advanced",
  discrimination:"planning",
  setup:() => {
    const threat = knownAssault("c");
    return board(
      {
        hp:1,
        energy:2,
        aiMemory:{ knownCardsByPlayer:threat.memory }
      },
      { b:{ hp:1 }, c:{ hand:[threat.card] } }
    );
  },
  grade:({ action }) => {
    if (barrierTo(action, "b")) return quality(QUALITY.OPTIMAL, "壁垒给暴露的1HP队友而非安全自身");
    if (barrierTo(action, "a")) return quality(QUALITY.SEVERE, "自身安全却壁垒自己");
    return quality(QUALITY.POOR, `非最优：${describeActionShort(action)}`);
  }
});

registerScenario({
  id:"oath.barrier-conserve-quota",
  name:"守誓者专项：壁垒先吸收伤害以保留护援额度与手牌",
  category:"planning",
  depth:2,
  difficulty:"advanced",
  discrimination:"planning",
  setup:() => {
    const threat = knownAssault("c");
    return board(
      { energy:2, hand:[makeCard("charge")], aiMemory:{ knownCardsByPlayer:threat.memory } },
      { b:{ hp:1 }, c:{ hand:[threat.card] } }
    );
  },
  grade:({ action }) => {
    if (barrierTo(action, "b")) return quality(QUALITY.OPTIMAL, "壁垒先吸收伤害，保留护援额度与手牌");
    if (isEnd(action)) return quality(QUALITY.POOR, "未发现壁垒可保留护援额度");
    return quality(QUALITY.SEVERE, `非最优：${describeActionShort(action)}`);
  }
});
