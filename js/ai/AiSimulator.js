/**
 * 轻量规划模拟器。构造器只接收过滤后的可见快照；深层推演不会访问 Game、
 * 他人手牌或未来牌堆，也不会触发 UI、日志、EventBus 或真实卡牌移动。
 */
export class AiSimulator {
  constructor(visibleState) { this.initial = structuredClone(visibleState); }

  clone(state = this.initial) { return structuredClone(state); }

  apply(state, abstractAction, viewerId) {
    const next = this.clone(state);
    const actor = next.players.find((player) => player.id === viewerId);
    if (!actor || abstractAction.type === "end") return next;
    const card = abstractAction.card;
    const targetId = abstractAction.targets?.[0]?.id;
    const target = next.players.find((player) => player.id === targetId);
    if (card) {
      actor.hand = (actor.hand ?? []).filter((entry) => entry.id !== card.id);
      actor.handCount = Math.max(0, actor.handCount - 1);
      if (card.definitionId === "recover") actor.hp = Math.min(actor.maxHp, actor.hp + 1);
      if (card.definitionId === "recover") actor.recoverUsed += 1;
      if (card.definitionId === "charge") actor.energy = Math.min(actor.maxEnergy, actor.energy + 1);
      if (card.definitionId === "harvest") actor.handCount += 2;
      if (card.definitionId === "exposeWeakness") actor.exposeWeaknessStacks = (actor.exposeWeaknessStacks ?? 0) + 1;
      if (card.definitionId === "assault" && target) {
        target.hp -= 1 + (actor.exposeWeaknessStacks ?? 0);
        actor.exposeWeaknessStacks = 0;
        actor.attackUsed += 1;
      }
      if (card.definitionId === "shockwave") for (const player of next.players) if (player.alive && player.battleTeam !== actor.battleTeam) player.hp -= 1;
      if (["plunder","transfer"].includes(card.definitionId) && target) { target.handCount = Math.max(0, target.handCount - 1); actor.handCount += 1; }
      if (card.definitionId === "destroy" && target) target.handCount = Math.max(0, target.handCount - 1);
      if (card.category === "equipment") actor.equipmentDefinitionId = card.definitionId;
    }
    for (const player of next.players) if (player.hp <= 0) player.alive = false;
    return next;
  }
}
