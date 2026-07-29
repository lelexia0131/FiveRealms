/**
 * 本文件注册十二种卡牌的实际结算函数，依赖 Game 提供的统一状态变更接口。
 * 它不从 DOM 读取目标、不直接改生命，也不决定 AI 是否出牌；所有伤害、治疗、移动都会回到核心系统。
 * 新卡牌需在 cardConfig 中声明，并在 CARD_EFFECTS 中注册同名 definitionId。
 */
import { randomChoice } from "../utils/helpers.js";

/** @type {Record<string, (game:Object,source:Object,card:Object,targets:Array<Object>,context:Object)=>Promise<Object|void>>} */
const CARD_EFFECTS = {
  async assault(game, source, card, targets, context) {
    source.turnFlags.attackUsed += 1;
    await game.damage(source, targets[0], 1, { card, canBlock: true, damageType: "normal", resolutionId: context.resolutionId });
  },

  async recover(game, source, card, targets, context) {
    source.turnFlags.recoverUsed += 1;
    await game.heal(source, source, 1, { card, resolutionId: context.resolutionId });
  },

  async support(game, source, card, targets) {
    const target = targets[0];
    target.shield += 1;
    target.statuses.temporaryShield = { clearAtTurnStart: true };
    game.log(`${source.name}援护${target.name}，令其获得1点临时护盾。`, "heal");
  },

  async insight(game, source) {
    await game.drawCards(source, 2, "洞察");
    if (!source.hand.length) return;
    let selected = [];
    if (source.controllerType === "human") selected = await game.ui.requestDiscard(source, 1, "洞察要求弃置1张牌");
    else selected = game.aiController.chooseDiscards(source, 1);
    if (selected[0]) await game.discardCardFromHand(source, selected[0], "洞察");
  },

  async exposeWeakness(game, source, card, targets) {
    const target = targets[0];
    target.statuses.exposed = { stacks: 1, sourceId: source.id };
    game.log(`${target.name}被看破了势头，获得1层破绽。`, "important");
  },

  async shockwave(game, source, card, targets, context) {
    // 群体牌逐个目标等待响应和胜负检查；一次性扣血会跳过格挡、护援与阵亡中止。
    for (const target of [...targets]) {
      if (game.state.isGameOver) break;
      if (target.alive) await game.damage(source, target, 1, { card, canBlock: true, damageType: "area", resolutionId: context.resolutionId });
    }
  },

  async steal(game, source, card, targets) {
    const target = targets[0];
    const stolen = randomChoice(target.hand, game.random);
    if (!stolen) return;
    await game.moveCardBetweenHands(target, source, stolen, "夺取");
    game.log(`${source.name}从${target.name}处夺取了「${stolen.name}」。`, "important");
  },

  async charge(game, source) {
    await game.gainEnergy(source, 1, { card: null, reason: "聚能" });
  },

  async coreDevice(game, source, card) {
    const equipped = await game.equipCard(source, card);
    return { destination: equipped ? "equipment" : "discard" };
  },

  // 三种响应牌不允许主动进入这里。显式处理可让错误调用快速失败而不是静默修改状态。
  async block() { throw new Error("格挡只能作为响应牌使用"); },
  async redirect() { throw new Error("转移只能作为响应牌使用"); },
  async counter() { throw new Error("反制只能作为响应牌使用"); }
};

/**
 * 结算一张已通过合法性检查且已进入 resolvingCards 的牌。
 * @returns {Promise<{destination:string}>} 卡牌结算后的目标区域。
 */
export async function resolveCardEffect(game, source, card, targets, context) {
  const resolver = CARD_EFFECTS[card.definitionId];
  if (!resolver) throw new Error(`未注册卡牌效果：${card.definitionId}`);
  const result = await resolver(game, source, card, targets, context);
  return { destination: "discard", ...(result ?? {}) };
}

/** 返回是否存在指定卡牌结算器，供启动自检使用。 */
export function hasCardResolver(definitionId) {
  return typeof CARD_EFFECTS[definitionId] === "function";
}
