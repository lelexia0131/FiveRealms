import { CHARACTER_DEFINITIONS, CHARACTER_BY_ID } from "../domain/definitions/characters/CharacterDefinitions.js";
import { RULESET_DEFINITION } from "../domain/definitions/ruleset/RulesetDefinition.js";
import { TeamAssignment } from "../application/match/TeamAssignment.js";
import { TEAM_ASSIGNMENT_MODE } from "../application/match/TeamAssignmentMode.js";
import { MATCH_MODE } from "../application/match/MatchMode.js";
import { NETWORK_ROLE } from "./NetworkProtocol.js";
import { PLAYER_CONTROL } from "./PlayerControlRouter.js";

/*
功能
为一个已连接房间生成互斥角色池与既有合法座次。

调用方
Host NetworkSession 首次 PEER_CONNECTED。

输入
可注入 [0,1) RNG。

输出
冻结的 pools 与 seats。

读取状态
canonical 角色和 TeamAssignment。

写入状态
无。

调用函数
TeamAssignment.assignTeams。

边界与不变量
仅房主调用一次；角色池随机排列，不改变角色或阵营规则。
*/
export function createNetworkSetup(random = Math.random) {
  const ids = CHARACTER_DEFINITIONS.map((character) => character.id);
  const count = RULESET_DEFINITION.characterCandidateCount;
  if (ids.length !== count * 2) throw new Error("双人征召需要两个等大的角色池");
  for (let index = ids.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [ids[index], ids[other]] = [ids[other], ids[index]];
  }
  const pools = Object.freeze({
    HOST: Object.freeze(ids.slice(0, count)),
    GUEST: Object.freeze(ids.slice(count))
  });
  const seats = Object.freeze(TeamAssignment.assignTeams(random, TEAM_ASSIGNMENT_MODE.RANDOM)
    .map((teamId, index) => Object.freeze({ seatId: `seat-${index}`, teamId })));
  return Object.freeze({ pools, seats });
}

/*
功能
验证角色属于该真人且席位与阵营匹配、未被另一人占用。

调用方
NetworkSession 选择、确认与最终 setup。

输入
setup、HOST/GUEST、独立 characterId/teamId/seatId 及双方选择。

输出
布尔值。

读取状态
分池与席位定义。

写入状态
无。

调用函数
无。

边界与不变量
双方可同队，角色不绑定阵营；不覆盖另一人的预选席位。
*/
export function isNetworkSelectionValid(setup, role, selection, selections = {}) {
  const peer = role === NETWORK_ROLE.HOST ? NETWORK_ROLE.GUEST : NETWORK_ROLE.HOST;
  return Boolean(selection && setup?.pools?.[role]?.includes(selection.characterId)
    && setup.seats.some((seat) => seat.seatId === selection.seatId && seat.teamId === selection.teamId)
    && selections[peer]?.seatId !== selection.seatId);
}

/*
功能
在双方确认后合成唯一五席 Match 描述。

调用方
Host NetworkSession。

输入
房间 setup、双方 selection 与 ready。

输出
冻结 Match setup；未就绪返回 null。

读取状态
canonical characterId 与席位。

写入状态
无。

调用函数
isNetworkSelectionValid。

边界与不变量
选角只 shuffle 一次，余下三个 AI 使用该排列剩余角色，角色不重复。
*/
export function finalizeNetworkSetup(setup, selections, ready) {
  if (ready?.HOST !== true || ready?.GUEST !== true) return null;
  for (const role of Object.values(NETWORK_ROLE)) {
    if (!isNetworkSelectionValid(setup, role, selections[role], selections)) throw new Error("联机选择无效");
  }
  const unused = [...setup.pools.HOST, ...setup.pools.GUEST]
    .filter((id) => !Object.values(selections).some((selection) => selection.characterId === id));
  const players = setup.seats.map((seat) => {
    const role = Object.values(NETWORK_ROLE).find((entry) => selections[entry].seatId === seat.seatId) ?? null;
    return Object.freeze({
      ...seat, playerId: role ? `network-${role.toLowerCase()}` : `network-ai-${seat.seatId}`,
      role, characterId: role ? selections[role].characterId : unused.shift()
    });
  });
  return Object.freeze({ mode: MATCH_MODE.NETWORK, players: Object.freeze(players) });
}

/*
功能
把共享五席 setup 投影成本地视角及统一控制来源。

调用方
network 页面 Match 装配。

输入
最终 setup 与本地角色。

输出
冻结 players，每人有独立 playerId/seatId/teamId/characterId/controlType。

读取状态
最终 setup。

写入状态
无。

调用函数
无。

边界与不变量
旋转座次使既有 UI 的本地玩家仍在索引零，保持环顺序与稳定 seatId。
*/
export function projectNetworkMatch(setup, localRole) {
  const localIndex = setup.players.findIndex((player) => player.role === localRole);
  if (localIndex < 0) throw new Error("缺少本地真人席位");
  return Object.freeze({
    mode: MATCH_MODE.NETWORK,
    players: Object.freeze(setup.players.map((_, index) => {
      const player = setup.players[(index + localIndex) % setup.players.length];
      if (!CHARACTER_BY_ID[player.characterId]) throw new Error("未知角色");
      return Object.freeze({ ...player, seatIndex: index,
        controlType: !player.role ? PLAYER_CONTROL.AI
          : player.role === localRole ? PLAYER_CONTROL.LOCAL_HUMAN : PLAYER_CONTROL.REMOTE_HUMAN });
    }))
  });
}

/*
功能
验证远端 setup 快照的角色全集与既有五席阵营不变量。

调用方
Guest 接收 Host 快照。

输入
setup。

输出
布尔值。

读取状态
Ruleset 与 canonical 角色。

写入状态
无。

调用函数
无。

边界与不变量
两池等大且无重复；晨星两席隔座，暮影三席，seatId 唯一。
*/
export function isNetworkSetupValid(setup) {
  const count = RULESET_DEFINITION.characterCandidateCount;
  if (setup?.pools?.HOST?.length !== count || setup?.pools?.GUEST?.length !== count
    || setup?.seats?.length !== RULESET_DEFINITION.playerCount) return false;
  const ids = [...setup.pools.HOST, ...setup.pools.GUEST];
  if (new Set(ids).size !== CHARACTER_DEFINITIONS.length || ids.some((id) => !CHARACTER_BY_ID[id])) return false;
  const seats = setup.seats;
  return new Set(seats.map((seat) => seat.seatId)).size === seats.length
    && seats.every((seat, index) => seat.seatId === `seat-${index}` && ["dawn", "dusk"].includes(seat.teamId))
    && seats.filter((seat) => seat.teamId === "dawn").length === RULESET_DEFINITION.smallTeamSize
    && seats.every((seat, index) => seat.teamId !== "dawn" || seats[(index + 1) % seats.length].teamId !== "dawn");
}
