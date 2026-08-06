/**
 * 阵营补偿的唯一查询服务。依赖 Game 状态与 gameConfig，不修改玩家状态；
 * 初始牌、回合额度和能量阶段都应调用这里，避免散落 teamSize === 2 判断。
 */
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260806-ai-block-consumption-v90";

/** 阵营人数补偿的唯一规则入口。 */
export class TeamRuleService {
  constructor(game) { this.game = game; }

  getTeamSize(playerOrTeam) {
    const team = typeof playerOrTeam === "string" ? playerOrTeam : playerOrTeam?.battleTeam;
    return this.game.state.players.filter((player) => player.battleTeam === team).length;
  }

  isSmallTeam(playerOrTeam) { return this.getTeamSize(playerOrTeam) === GAME_CONFIG.smallTeamSize; }
  getRules(player) { return this.isSmallTeam(player) ? GAME_CONFIG.smallTeamBonuses : GAME_CONFIG.largeTeamRules; }
  getInitialHandCount(player) { return this.getRules(player).initialHandCount ?? GAME_CONFIG.initialHandCount; }
  getDrawCount(player) { return this.getRules(player).drawCountPerTurn ?? GAME_CONFIG.defaultDrawCount; }
  getAttackLimit(player) { return this.getRules(player).attackLimitPerTurn; }
  getRecoverLimit(player) { return this.getRules(player).recoverLimitPerTurn; }
  getMaxEnergy(player) { return this.getRules(player).maxEnergy ?? GAME_CONFIG.defaultMaxEnergy; }
  getTurnEnergyGain(player) {
    const breakdown = this.getTurnEnergyBreakdown(player);
    return breakdown.baseAmount + breakdown.teamBonus + breakdown.equipmentBonus;
  }
  getTurnEnergyBreakdown(player) {
    const rules = this.getRules(player);
    return {
      baseAmount: rules.turnEnergyGain,
      teamBonus: rules.turnEnergyBonus ?? 0,
      equipmentBonus: player.equipment?.definitionId === "energyDevice" ? 1 : 0
    };
  }
}
