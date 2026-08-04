/**
 * 本文件负责 2V3 阵营生成与阵营查询，依赖游戏配置和洗牌工具。
 * 它不根据角色、名字或座位推断阵营；battleTeam 是唯一判断来源。
 */
import { GAME_CONFIG } from "../config/gameConfig.js?build=20260804-all-in-availability-v59";

export class TeamManager {
  /**
   * 随机返回每个座位的阵营 ID，严格保证 2V3。
   * @param {()=>number} random 随机源。
   * @returns {Array<"dawn"|"dusk">} 与座位索引一一对应的阵营。
   */
  static assignTeams(random = Math.random) {
    if (GAME_CONFIG.smallTeamSize + GAME_CONFIG.largeTeamSize !== GAME_CONFIG.playerCount) {
      throw new Error("阵营人数配置之和必须等于玩家总数");
    }
    const smallTeam = random() < 0.5 ? "dawn" : "dusk";
    const largeTeam = smallTeam === "dawn" ? "dusk" : "dawn";
    // 两名小队成员固定隔座，再随机旋转与翻转；因此永不相邻且真人仍可能进入任一队。
    let seats = [smallTeam, largeTeam, smallTeam, largeTeam, largeTeam];
    if (random() < 0.5) seats = [...seats].reverse();
    const rotation = Math.floor(random() * seats.length);
    return seats.map((_, index) => seats[(index + rotation) % seats.length]);
  }

  /** 返回某阵营的总座位数，用于判断小队的开局手牌、摸牌与行动补偿。 */
  static teamSize(players, teamId) {
    return players.filter((player) => player.battleTeam === teamId).length;
  }
}
