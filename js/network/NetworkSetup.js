import { CHARACTER_DEFINITIONS, CHARACTER_BY_ID } from "../domain/definitions/characters/CharacterDefinitions.js";
import { RULESET_DEFINITION } from "../domain/definitions/ruleset/RulesetDefinition.js";
import { TeamAssignment } from "../application/match/TeamAssignment.js";
import { TEAM_ASSIGNMENT_MODE } from "../application/match/TeamAssignmentMode.js";
import { MATCH_MODE } from "../application/match/MatchMode.js";
import { PLAYER_CONTROL } from "./PlayerControlRouter.js";

/*
功能
生成房间共享角色排列与 canonical 五席阵营。

调用方
Host NetworkSession.open。

输入
可注入的 [0,1) RNG。

输出
冻结的 candidates 与 seats。

读取状态
canonical 角色与 TeamAssignment。

写入状态
无。

调用函数
TeamAssignment.assignTeams。

边界与不变量
仅 Host 每个房间生成一次；不改变 2V3 座次规则。
*/

export function createNetworkSetup(random = Math.random) {
  const candidates = CHARACTER_DEFINITIONS.map((character) => character.id);
  for (let index = candidates.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [candidates[index], candidates[other]] = [candidates[other], candidates[index]];
  }
  const seats = TeamAssignment.assignTeams(random, TEAM_ASSIGNMENT_MODE.RANDOM)
    .map((teamId, index) => Object.freeze({ seatId: `seat-${index}`, teamId }));
  return Object.freeze({ candidates: Object.freeze(candidates), seats: Object.freeze(seats) });
}

/*
功能
验证真人自己的角色与席位选择不与其他成员冲突。

调用方
NetworkSession 选择、确认与最终 setup。

输入
setup、participantId、selection 与 participant keyed 成员。

输出
布尔值。

读取状态
共享候选、席位、有效成员及其 selection。

写入状态
无。

调用函数
无。

边界与不变量
同一真人最多一项 selection；同一角色或席位最多一个真人。
*/

export function isNetworkSelectionValid(setup, participantId, selection, participants = {}) {
  const participant = participants[participantId];
  return Boolean(participant?.connected && !participant.kicked && selection
    && setup?.candidates?.includes(selection.characterId)
    && setup.seats.some((seat) => seat.seatId === selection.seatId && seat.teamId === selection.teamId)
    && Object.values(participants).every((other) => other.participantId === participantId
      || !other.selection || (other.selection.seatId !== selection.seatId && other.selection.characterId !== selection.characterId)));
}

/*
功能
把 participant 自报展示名收束为安全 metadata。

调用方
NetworkSession 成员建立与 HELLO 握手、networkParticipantLabel。

输入
任意 displayName 候选值。

输出
trim 后合法返回 1–20 字符，否则返回 null。

读取状态
无。

写入状态
无。

调用函数
String、Array.from、RegExp.test。

边界与不变量
displayName 只是展示 metadata，不参与 participantId、connectionId 或 controller ownership 判断；重名允许。
*/
export function normalizeParticipantDisplayName(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || /[\u0000-\u001F\u007F-\u009F]/u.test(normalized)) return null;
  if (Array.from(normalized).length > 20) return null;
  return normalized;
}

/*
功能
从已确认真人选择合成五席及唯一 controller ownership。

调用方
Host NetworkSession.start；Guest 快照验证。

输入
setup 与 participant keyed 成员。

输出
冻结 Match setup；成员未确认返回 null。

读取状态
成员 selection/ready、canonical 席位。

写入状态
无。

调用函数
isNetworkSelectionValid。

边界与不变量
AI 只补空席，不进入 participant 集合；角色不重复且不重洗。
*/

export function finalizeNetworkSetup(setup, participants) {
  const humans = Object.values(participants);
  if (!humans.length || humans.some((participant) => !participant.ready)) return null;
  // 锁房后的首次投影可能已经包含断线成员：验证其原始选角关系，控制权仍按当前连接状态投影。
  const selectionOwners = Object.fromEntries(humans.map((participant) => [
    participant.participantId, { ...participant, connected: true, kicked: false }
  ]));
  for (const participant of humans) {
    if (!isNetworkSelectionValid(setup, participant.participantId, participant.selection, selectionOwners)) throw new Error("联机选择无效");
  }
  const unused = setup.candidates.filter((id) => !humans.some((participant) => participant.selection.characterId === id));
  const players = setup.seats.map((seat) => {
    const owner = humans.find((participant) => participant.selection.seatId === seat.seatId);
    const humanControlled = owner?.connected && !owner.kicked;
    return Object.freeze({
      ...seat, playerId: `network-${seat.seatId}`,
      controller: Object.freeze({
        type: humanControlled ? owner.role : "AI",
        participantId: humanControlled ? owner.participantId : null,
        displayName: humanControlled ? (owner.displayName ?? null) : null
      }),
      characterId: owner ? owner.selection.characterId : unused.shift()
    });
  });
  return Object.freeze({ mode: MATCH_MODE.NETWORK, players: Object.freeze(players) });
}

/*
功能
按本地 participant 身份投影五席控制来源与展示标签。

调用方
NetworkSession.snapshot。

输入
最终 setup、本地 participantId 与真人成员。

输出
冻结 Match setup，每席同时携带 displayName 展示 alias。

读取状态
seat controller ownership、displayName 与 guestOrdinal。

写入状态
无。

调用函数
networkParticipantLabel。

边界与不变量
canonical 席序不变；本地身份从 participantId 读取，AI 不冒充真人。
*/

export function projectNetworkMatch(setup, localParticipantId, participants) {
  return Object.freeze({
    mode: MATCH_MODE.NETWORK,
    players: Object.freeze(setup.players.map((player, seatIndex) => {
      const displayName = player.controller.type === "AI"
        ? "AI"
        : networkParticipantLabel(participants[player.controller.participantId]);
      return Object.freeze({
        ...player, seatIndex, displayName, networkRole: displayName,
        controlType: player.controller.type === "AI" ? PLAYER_CONTROL.AI
          : player.controller.participantId === localParticipantId ? PLAYER_CONTROL.LOCAL_HUMAN : PLAYER_CONTROL.REMOTE_HUMAN
      });
    }))
  });
}

/*
功能
把真人成员转换为 Lobby 与 controller 的展示标签。

调用方
Lobby 与 controller 投影。

输入
authority participant。

输出
优先 displayName；旧连接缺少 displayName 时回退 Host 或 Guest ordinal。

读取状态
displayName、role 与 guestOrdinal。

写入状态
无。

调用函数
normalizeParticipantDisplayName。

边界与不变量
只用于展示，不反向解析身份；displayName 重名不影响 participantId 或 controller ownership。
*/

export function networkParticipantLabel(participant) {
  const displayName = normalizeParticipantDisplayName(participant?.displayName);
  if (displayName) return displayName;
  return participant?.role === "HOST" ? "Host" : `Guest ${participant?.guestOrdinal ?? "?"}`;
}

/*
功能
校验共享角色全集和既有五席阵营不变量。

调用方
Guest 接收 Host setup。

输入
setup。

输出
布尔值。

读取状态
canonical 角色与 Ruleset。

写入状态
无。

调用函数
无。

边界与不变量
五席唯一，晨星两席隔座，暮影三席；角色排列无重复。
*/

export function isNetworkSetupValid(setup) {
  const ids = setup?.candidates;
  if (!Array.isArray(ids) || ids.length !== CHARACTER_DEFINITIONS.length
    || new Set(ids).size !== ids.length || ids.some((id) => !CHARACTER_BY_ID[id])
    || setup?.seats?.length !== RULESET_DEFINITION.playerCount) return false;
  const seats = setup.seats;
  return new Set(seats.map((seat) => seat.seatId)).size === seats.length
    && seats.every((seat, index) => seat.seatId === `seat-${index}` && ["dawn", "dusk"].includes(seat.teamId))
    && seats.filter((seat) => seat.teamId === "dawn").length === RULESET_DEFINITION.smallTeamSize
    && seats.every((seat, index) => seat.teamId !== "dawn" || seats[(index + 1) % seats.length].teamId !== "dawn");
}
