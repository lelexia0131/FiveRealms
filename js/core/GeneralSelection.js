/**
 * 本文件封装真人候选与电脑角色分配，依赖角色配置和随机工具。
 * 它不进入对局循环，也不改变阵营；角色与 battleTeam 始终保持独立。
 */
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260814-guardian-aid-discard";
import { GENERAL_DEFINITIONS } from "../config/generalConfig.js?build=20260814-guardian-aid-discard";
import { shuffled } from "../utils/helpers.js?build=20260814-guardian-aid-discard";

export class GeneralSelection {
  constructor(random = Math.random) {
    this.random = random;
  }

  /** 随机生成不重复候选；若允许重复仍优先展示不同角色。 */
  createCandidates() {
    return shuffled(GENERAL_DEFINITIONS, this.random).slice(0, GAME_CONFIG.generalCandidateCount);
  }

  /**
   * 为四名电脑分配剩余角色。采用简单标签多样性权重，避免同队全为同类定位。
   * @param {Array<Player>} aiPlayers 电脑座位。
   * @param {string} selectedGeneralId 真人已选角色 ID。
   * @returns {Array<Object>} 按 aiPlayers 顺序排列的角色配置。
   */
  assignAiGenerals(aiPlayers, selectedGeneralId, smallTeamId = null) {
    const pool = shuffled(GENERAL_DEFINITIONS.filter((general) => GAME_CONFIG.allowDuplicateGenerals || general.id !== selectedGeneralId), this.random);
    const assigned = [];
    for (const player of aiPlayers) {
      const teammateTags = assigned
        .filter((entry) => entry.player.battleTeam === player.battleTeam)
        .flatMap((entry) => entry.general.tags);
      const ranked = pool.map((general, index) => ({
        general,
        index,
        diversity: general.tags.filter((tag) => !teammateTags.includes(tag)).length
          + (player.battleTeam === smallTeamId ? ({ "ember-magus":10, "trail-hunter":9, "oath-warden":8, "blade-walker":5, "resonance-tuner":3 }[general.id] ?? 0) : 0)
          + this.random() * 0.5
      })).sort((a, b) => b.diversity - a.diversity);
      const choice = ranked[0];
      assigned.push({ player, general: choice.general });
      if (!GAME_CONFIG.allowDuplicateGenerals) pool.splice(choice.index, 1);
    }
    return assigned.map((entry) => entry.general);
  }
}
