/*
模块职责
唯一拥有卡牌主动使用、目标、转移、借势与范围适用性的纯规则决定；不拥有 async runtime、card movement、choice、response、AI policy 或 mutation。

上游
core/RuleEngine legacy façade 与 tests。

下游
Domain DistanceRules、TurnRules、StatusRules 与 definitions。

状态边界
只读 canonical player/card facts；不写状态。

信息边界
不读取 controllerType、aiMemory、UI、AI 或 hidden hand 内容。

架构约束
不得依赖 Game/RuleEngine/application/adapters/EventBus；不得 await、emit、随机、mutation。
*/
import { getDistance } from "../distance/DistanceRules.js?build=20260815-shadow-agent-p1-slot";
import { hasAttackUseRemaining } from "../turn/TurnRules.js?build=20260815-shadow-agent-p1-slot";
import { hasStatus } from "../status/StatusRules.js?build=20260815-shadow-agent-p1-slot";

/*
功能
查找 canonical player fact。

调用方
CardRules 内部与 RuleEngine adapter。

输入
players 与 id。

输出
player fact 或 null。

读取状态
无。

写入状态
无。

调用函数
Array.find。

边界与不变量
不返回实体。
*/
export function findPlayerFact(players, id) {
  return players.find((player) => player.id === id) ?? null;
}

/*
功能
判断两个 player facts 是否在确定距离范围内。

调用方
CardRules target/transfer rules。

输入
players、source、target 与 card facts。

输出
布尔值。

读取状态
alive/equipment facts。

写入状态
无。

调用函数
getDistance。

边界与不变量
自身恒 true；ignoresDistance 或未声明 effectRange 恒 true。
*/
export function isWithinEffectRange(players, source, target, card) {
  if (!source || !target || !target.alive) return false;
  if (source.id === target.id) return true;
  if (card?.ignoresDistance || card?.effectRange == null) return true;
  const distance = getDistance(
    players,
    source,
    target,
    source.equipmentDefinitionId ?? null,
    target.equipmentDefinitionId ?? null
  );
  return Number.isFinite(distance) && distance <= card.effectRange;
}

/*
功能
返回突袭可作用目标 ID（不含 attack usage 校验）。

调用方
CardRules 与 RuleEngine adapter。

输入
players、source 与 card facts。

输出
目标 ID 数组。

读取状态
alive/battleTeam/attackRange/equipment facts。

写入状态
无。

调用函数
getDistance、hasStatus。

边界与不变量
只包含存活敌人且在攻击范围内；不读取手牌或次数。
*/
export function getCardTargetIds(players, source, card) {
  const alive = players.filter((player) => player.alive);
  const enemies = alive.filter((player) => player.battleTeam !== source.battleTeam);
  switch (card.targetType) {
    case "singleEnemyInRange":
      return enemies.filter((target) => {
        const distance = getDistance(
          players, source, target,
          source.equipmentDefinitionId ?? null,
          target.equipmentDefinitionId ?? null
        );
        return Number.isFinite(distance) && distance <= (source.attackRange ?? 0);
      }).map((player) => player.id);
    case "singleEnemy": return enemies.map((player) => player.id);
    case "singleUnsealedEnemy": return enemies.filter((target) => !hasStatus(target, "sealed")).map((player) => player.id);
    case "otherWithCards": return alive.filter((player) => player.id !== source.id && player.handCount > 0).map((player) => player.id);
    case "otherWithCardsOrEquipment":
      return alive.filter((player) => player.id !== source.id
        && (player.handCount > 0 || player.equipmentDefinitionId)
        && isWithinEffectRange(players, source, player, card)).map((player) => player.id);
    case "anyWithCards": return alive.filter((player) => player.handCount > 0).map((player) => player.id);
    case "singleAlly": return alive.filter((player) => player.battleTeam === source.battleTeam).map((player) => player.id);
    case "self": return [source.id];
    case "allEnemies": return enemies.map((player) => player.id);
    case "allLiving": return alive.map((player) => player.id);
    case "multiStage": return alive.map((player) => player.id);
    case "none": return [];
    default: return [];
  }
}

/*
功能
返回借势第二目标候选 ID。

调用方
CardRules 与 RuleEngine adapter。

输入
players、source 与 source facts。

输出
目标 ID 数组。

读取状态
alive/attackRange/equipment facts。

写入状态
无。

调用函数
getDistance。

边界与不变量
只要求存活、非 source 且首目标攻击范围内；不检查阵营/手牌/突袭次数。
*/
export function getAssaultTargetIds(players, source) {
  return players.filter((target) => target.alive
    && target.id !== source.id
    && (() => {
      const distance = getDistance(
        players, source, target,
        source.equipmentDefinitionId ?? null,
        target.equipmentDefinitionId ?? null
      );
      return Number.isFinite(distance) && distance <= (source.attackRange ?? 0);
    })()).map((player) => player.id);
}

/*
功能
返回借势第一目标候选 ID。

调用方
CardRules 与 RuleEngine adapter。

输入
players、source 与 card facts。

输出
目标 ID 数组。

读取状态
alive/equipment facts 与 second-target candidates。

写入状态
无。

调用函数
getAssaultTargetIds。

边界与不变量
第一目标必须持有装备且至少有一个距离合法第二目标。
*/
export function getLeverageFirstTargetIds(players, source) {
  return players.filter((player) => player.id !== source.id
    && player.alive
    && Boolean(player.equipmentDefinitionId)
    && getAssaultTargetIds(players, player).length > 0).map((player) => player.id);
}

/*
功能
判断 canonical facts 是否仍有可转移手牌或装备。

调用方
CardRules 与 RuleEngine adapter。

输入
player fact 与 excludedCardIds。

输出
布尔值。

读取状态
handCount/equipmentDefinitionId。

写入状态
无。

调用函数
无。

边界与不变量
excludedCardIds 只扣除显式 card id。
*/
export function hasHandOrEquipmentFacts(player, excludedCardIds = null) {
  return Boolean(
    (excludedCardIds ? Math.max(0, (player.handCount ?? 0) - (excludedCardIds.has(player.id) ? 1 : 0)) : (player.handCount ?? 0)) > 0
    || player.equipmentDefinitionId
  );
}

/*
功能
返回可转移来源 ID。

调用方
CardRules 与 RuleEngine adapter。

输入
players、source、card facts 与 excludedCardIds。

输出
来源 ID 数组。

读取状态
alive/handCount/equipment/range facts。

写入状态
无。

调用函数
hasHandOrEquipmentFacts、isWithinEffectRange。

边界与不变量
excluded card 不参与 handCount。
*/
export function getTransferSourceIds(players, source, card, excludedCardIds = null) {
  const excluded = excludedCardIds ?? new Set([card?.id].filter(Boolean));
  return players.filter((player) => player.alive
    && player.handCount > 0
    && isWithinEffectRange(players, source, player, card)).map((player) => player.id);
}

/*
功能
返回转移接收者 ID。

调用方
CardRules 与 RuleEngine adapter。

输入
players、source、from 与 card facts。

输出
接收者 ID 数组。

读取状态
alive/range facts。

写入状态
无。

调用函数
isWithinEffectRange。

边界与不变量
排除 from 自身。
*/
export function getTransferReceiverIds(players, source, from, card) {
  return players.filter((player) => player.alive
    && player.id !== from.id
    && isWithinEffectRange(players, source, player, card)).map((player) => player.id);
}

/*
功能
判断突袭是否可实际使用。

调用方
RuleEngine adapter 与 tests。

输入
players、sourceId、card facts、targetId、usage facts 与放宽选项。

输出
{ ok, reason }。

读取状态
存活、phase、hand membership、usage 与目标 facts。

写入状态
无。

调用函数
hasAttackUseRemaining、getAssaultTargetIds。

边界与不变量
forced assault 只放宽出牌阶段与次数；target 缺失时要求至少一个合法目标。
*/
export function canActuallyUseAssault({
  players,
  sourceId,
  currentPlayerId,
  phase,
  card,
  inHand,
  targetId = null,
  usage = { used: 0, limit: 0 },
  allowOutOfTurn = false,
  ignoreAttackLimit = false
}) {
  const source = findPlayerFact(players, sourceId);
  if (!source?.alive) return { ok: false, reason: "角色已阵亡或离场" };
  if (!card || card.definitionId !== "assault" || !inHand) return { ok: false, reason: "突袭已不在手中" };
  if (card.usageMode === "response" || card.targetType === "responseOnly") return { ok: false, reason: "该牌不能主动使用" };
  if (!allowOutOfTurn && !(phase === "play" && currentPlayerId === sourceId)) {
    return { ok: false, reason: "现在不是你的出牌阶段" };
  }
  if (!ignoreAttackLimit && !hasAttackUseRemaining(usage)) return { ok: false, reason: "本回合突袭次数已用尽" };
  const candidates = getAssaultTargetIds(players, source);
  if (targetId && !candidates.includes(targetId)) return { ok: false, reason: "目标不再是合法突袭目标" };
  if (!targetId && !candidates.length) return { ok: false, reason: "攻击距离内没有敌人" };
  return { ok: true, reason: "" };
}

/*
功能
判断主动卡牌是否合法可出。

调用方
RuleEngine adapter 与 tests。

输入
players、sourceId、currentPlayerId、phase、card facts、inHand、assault usage 与 recover usage。

输出
{ ok, reason }。

读取状态
source facts、statuses、turn usage 与 target facts。

写入状态
无。

调用函数
canActuallyUseAssault、hasAttackUseRemaining、hasStatus、getCardTargetIds、getTransferSourceIds、getTransferReceiverIds、getLeverageFirstTargetIds。

边界与不变量
reason 文案与旧 RuleEngine 完全一致。
*/
export function canPlayCard({
  players,
  sourceId,
  currentPlayerId,
  phase,
  card,
  inHand,
  assaultUsage = { used: 0, limit: 0 },
  recoverUsed = 0,
  recoverLimit = null,
  transferSourceIds = null
}) {
  const source = findPlayerFact(players, sourceId);
  if (!source?.alive) return { ok: false, reason: "角色已阵亡" };
  if (!(phase === "play" && currentPlayerId === sourceId)) return { ok: false, reason: "现在不是你的出牌阶段" };
  if (!inHand) return { ok: false, reason: "这张牌已不在手中" };
  if (card.usageMode === "response" || card.targetType === "responseOnly") return { ok: false, reason: "这张牌只能在对应响应时机使用" };
  if (card.definitionId === "assault") {
    const assaultLegality = canActuallyUseAssault({
      players, sourceId, currentPlayerId, phase, card, inHand, usage: assaultUsage
    });
    if (!assaultLegality.ok) return assaultLegality;
  }
  if (card.definitionId === "recover") {
    if (source.hp >= source.maxHp) return { ok: false, reason: "生命已满" };
    if (!(recoverLimit === null || recoverLimit === undefined || recoverUsed < recoverLimit)) {
      return { ok: false, reason: "本回合调息次数已用尽" };
    }
  }
  if (card.definitionId === "charge" && source.energy >= source.maxEnergy) return { ok: false, reason: "能量已经充满" };
  if (card.definitionId === "lightning" && hasStatus(source, "lightning")) return { ok: false, reason: "已处于闪电状态，不能再次使用闪电" };
  if (card.targetType === "otherWithCards" && !getCardTargetIds(players, source, card).length) return { ok: false, reason: "没有可选择手牌的其他角色" };
  if (card.targetType === "otherWithCardsOrEquipment" && !getCardTargetIds(players, source, card).length) return { ok: false, reason: "范围内没有可选择手牌或装备的其他角色" };
  if (card.targetType === "singleAlly" && !getCardTargetIds(players, source, card).length) return { ok: false, reason: "没有可选择的存活队友" };
  if (["singleEnemy", "singleEnemyInRange", "singleUnsealedEnemy", "allEnemies"].includes(card.targetType) && !getCardTargetIds(players, source, card).length) return { ok: false, reason: "没有合法敌方目标" };
  if (card.definitionId === "transfer") {
    const sources = transferSourceIds ?? getTransferSourceIds(players, source, card);
    if (!sources.some((fromId) => getTransferReceiverIds(players, source, findPlayerFact(players, fromId), card).length)) {
      return { ok: false, reason: "距离1内没有可转移手牌的来源和接收者" };
    }
  }
  if (card.definitionId === "leverage" && !getLeverageFirstTargetIds(players, source).length) {
    return { ok: false, reason: "没有装备区有真实装备且能够突袭的其他角色" };
  }
  return { ok: true, reason: "" };
}
