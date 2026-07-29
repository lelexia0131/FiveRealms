/**
 * 本文件组合行动生成、合法性检查、评分、角色偏好、随机扰动与选择。
 * 它依赖 RuleEngine、技能注册表和 AI 可见状态，不直接修改 GameState；实际执行必须调用 Game 的统一接口。
 * 单回合由 Game 设置动作上限，避免无法改变状态的行动导致无限循环。
 */
import { GAME_CONFIG } from "../config/gameConfig.js";
import { RuleEngine } from "../core/RuleEngine.js";
import { getActiveSkill } from "../generals/skillRegistry.js";
import { createAiVisibleState } from "./AiVisibleState.js";
import { ThreatCalculator } from "./ThreatCalculator.js";
import { randomChoice } from "../utils/helpers.js";
import { Debug } from "../utils/debug.js";

export class AIController {
  /** @param {Object} game 当前对局，执行动作时仍通过其公开方法。 */
  constructor(game) {
    this.game = game;
  }

  /**
   * 生成当前 AI 的全部合法出牌、技能与结束行动。
   * @returns {Array<Object>} 不包含任何非法目标的行动数组。
   */
  getLegalActions(player) {
    const actions = [];
    for (const card of player.hand) {
      if (!RuleEngine.canPlayCard(this.game, player, card).ok) continue;
      const targets = RuleEngine.getCardTargets(this.game, player, card);
      if (["none", "self"].includes(card.targetType)) actions.push({ type: "card", card, targets: card.targetType === "self" ? [player] : [] });
      else if (card.targetType === "allEnemies") actions.push({ type: "card", card, targets });
      else for (const target of targets) actions.push({ type: "card", card, targets: [target] });
    }
    const skill = getActiveSkill(player);
    if (skill?.canUse(this.game, player).ok) {
      const targets = RuleEngine.getSkillTargets(this.game, player, skill.id);
      if (["none", "allEnemies"].includes(skill.targetType)) actions.push({ type: "skill", skill, targets: [] });
      else for (const target of targets) actions.push({ type: "skill", skill, targets: [target] });
    }
    actions.push({ type: "end", targets: [] });
    Debug.log("AI", `${player.name}合法行动`, actions.map((action) => ({ type: action.type, id: action.card?.definitionId ?? action.skill?.id ?? "end", target: action.targets[0]?.name })));
    return actions;
  }

  /**
   * 对行动评分。评估只读取过滤后的公开状态；自己的手牌内容来自合法私有视图。
   * @returns {number} 可比较的最终得分。
   */
  evaluate(action, player, visibleState) {
    if (action.type === "end") return 0;
    const profile = player.general.aiProfile;
    const selfView = visibleState.players.find((entry) => entry.id === player.id);
    const targetView = action.targets[0] ? visibleState.players.find((entry) => entry.id === action.targets[0].id) : null;
    let score = 1;

    if (action.type === "card") {
      switch (action.card.definitionId) {
        case "assault": score = 6 * profile.aggression + ThreatCalculator.calculate(selfView, targetView, player.aiMemory, 1); break;
        case "recover": score = (player.maxHp - player.hp) * 8 * profile.healingPriority; break;
        case "support": score = (targetView.maxHp - targetView.hp + 1) * 5 * profile.support - targetView.shield * 2; break;
        case "insight": score = 7 + Math.max(0, 5 - player.hand.length) * 1.5 - profile.cardConservation; break;
        case "exposeWeakness": score = 5 + ThreatCalculator.calculate(selfView, targetView, player.aiMemory) * .35; break;
        case "shockwave": score = this.game.getEnemies(player).filter((target) => target.alive).length * 7 * profile.aggression; break;
        case "steal": score = 5 + targetView.handCount * 2; break;
        case "charge": score = 5 + (player.maxEnergy - player.energy) * 2 * profile.energyConservation; break;
        case "coreDevice": score = player.equipment ? 3 : 10; break;
        default: score = 1;
      }
      score -= action.card.aiValue * profile.cardConservation * .18;
    } else if (action.type === "skill") {
      switch (action.skill.id) {
        case "breakArmy": score = player.hand.some((card) => card.definitionId === "assault") ? 14 * profile.aggression : 3; break;
        case "barrier": score = (targetView.maxHp - targetView.hp + 2) * 4 * profile.support; break;
        case "symbiosis": score = (targetView.maxHp - targetView.hp) * 7 * profile.healingPriority - (player.hp <= 2 ? 6 : 0); break;
        case "stealSkill": score = 8 + targetView.handCount * 2; break;
        case "burningField": score = this.game.getEnemies(player).filter((target) => target.alive).length * 9 * profile.aggression; break;
        case "hunt": score = 13 + (targetView.hp <= 2 ? 18 : 0); break;
        case "allIn": score = player.energy * 5 * profile.riskTolerance + (player.hand.length < 3 ? 5 : 0); break;
        case "resonance": score = (6 - targetView.handCount) * 2.5 * profile.support; break;
        default: score = 1;
      }
      score -= action.skill.cost * profile.energyConservation * 1.5;
    }

    score *= GAME_CONFIG.aiDifficultyMultiplier;
    if (GAME_CONFIG.enableAiRandomness) score *= 1 + (this.game.random() * 2 - 1) * GAME_CONFIG.aiRandomnessRange;
    return score;
  }

  /** 生成、评分并选择最高分行动；至少返回 end。 */
  selectAction(player) {
    const visible = createAiVisibleState(player.id, this.game.state);
    const scored = this.getLegalActions(player).map((action) => ({ action, score: this.evaluate(action, player, visible) }));
    scored.sort((left, right) => right.score - left.score);
    Debug.log("AI", `${player.name}行动评分`, scored.map((item) => ({ id: item.action.card?.definitionId ?? item.action.skill?.id ?? "end", score: item.score })));
    return scored[0]?.action ?? { type: "end", targets: [] };
  }

  /**
   * 评估电脑是否响应。只读取自己的牌与公开伤害/卡牌类型，不检查敌人的隐藏牌。
   */
  shouldRespond(player, type, context) {
    const profile = player.general.aiProfile;
    let desire = 0;
    if (type === "block") {
      const amount = context.amount ?? 1;
      desire = (player.hp <= amount ? 1 : .42) + profile.defense * .2 - profile.responseConservation * .13;
    } else if (type === "counter") {
      const impact = context.card?.definitionId === "shockwave" ? this.game.getAllies(player).length * .22 : .35;
      desire = .35 + impact + profile.defense * .12 - profile.responseConservation * .15;
    } else if (type === "redirect") {
      desire = player.hp <= 2 ? .78 : .38 + profile.defense * .1;
    } else if (type === "guardianAid") {
      desire = context.target?.hp <= 2 ? .85 : .4 * profile.support;
      if (player.hand.length <= 1) desire -= profile.cardConservation * .25;
    }
    return this.game.random() < Math.max(.08, Math.min(.95, desire));
  }

  /** 选择价值最低的若干手牌弃置；不会查看其他角色手牌。 */
  chooseDiscards(player, count) {
    return [...player.hand].sort((left, right) => this.discardValue(left, player) - this.discardValue(right, player)).slice(0, count);
  }

  /** 返回单张牌的保留价值。低生命时格挡与调息更珍贵。 */
  discardValue(card, player) {
    let value = card.aiValue ?? 3;
    if (player.hp <= 2 && ["block", "recover"].includes(card.definitionId)) value += 7;
    if (player.energy >= player.maxEnergy && card.definitionId === "charge") value -= 3;
    if (player.equipment && card.definitionId === "coreDevice") value -= 2;
    return value;
  }

  /** 为转移响应选择合法目标，优先将效果导向生命较高者以保存自己。 */
  chooseRedirectTarget(player, alternatives) {
    const allies = alternatives.filter((target) => target.battleTeam === player.battleTeam);
    return [...(allies.length ? allies : alternatives)].sort((a, b) => (b.hp + b.shield) - (a.hp + a.shield))[0] ?? randomChoice(alternatives, this.game.random);
  }
}
