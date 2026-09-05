/*
模块职责
集中定义历史档案馆的稳定成就元数据与排序规则。

上游
AchievementTracker、AchievementStore 与历史成就 View。

下游
无。

状态边界
只提供冻结的静态定义，不读取或写入对局/历史状态。

信息边界
真实 criteria 只供判定层使用；UI 通过 AchievementStore 获取安全投影。

架构约束
成就 ID 一旦发布不得随文案变化；tier 仅为内部字段，UI 不显示等级文字。
*/

/*
功能
生成成就专属插画的稳定本地 URL。

调用方
静态成就定义初始化。

输入
稳定的成就 ID。

输出
指向 assets/achievements 的相对资源 URL。

读取状态
无。

写入状态
无。

调用函数
无。

边界与不变量
每个成就必须拥有独立文件，路径不能回退到通用角色或卡牌插画。
*/
const artwork = (achievementId) => `./assets/achievements/${achievementId}.svg`;

const definitions = [
  { id: "first_victory", tier: "common", hidden: false, title: "初胜", description: "档案馆第一道墨痕，记下你把整场战斗带回终点。", criteria: "赢得至少一场对局。", teamScope: "both", order: 1, artwork: artwork("first_victory") },
  { id: "skill_trinity", tier: "common", hidden: false, title: "三度回响", description: "三次主动技能让同一片战场听见你的节奏。", criteria: "单场主动技能使用次数达到 3 次。", teamScope: "both", order: 2, artwork: artwork("skill_trinity") },
  { id: "first_blood", tier: "common", hidden: false, title: "开阵", description: "敌阵裂开的一刻，先手的锋芒已经留下名字。", criteria: "单场击杀至少 1 名敌人。", teamScope: "both", order: 3, artwork: artwork("first_blood") },
  { id: "rescue_beacon", tier: "common", hidden: false, title: "回光", description: "同伴沉向深渊前，你替他点亮返场的路。", criteria: "单场成功救下至少 1 名濒死友军。", teamScope: "both", order: 4, artwork: artwork("rescue_beacon") },
  { id: "mvp_spotlight", tier: "common", hidden: false, title: "万众瞩目", description: "终局聚光灯落下时，整片战场只认得你的旗帜。", criteria: "获得 MVP。", teamScope: "both", order: 5, artwork: artwork("mvp_spotlight") },
  { id: "matches_ten", tier: "common", hidden: false, title: "初出茅庐", description: "十次出征铺成一条真正属于你的远征路。", criteria: "累计完成 10 次对局。", teamScope: "both", order: 6, artwork: artwork("matches_ten") },
  { id: "full_health", tier: "common", hidden: false, title: "完好无缺", description: "穿过喧嚣的战场，你的生命核心仍如出发时明亮。", criteria: "满血完成对局。", teamScope: "both", order: 7, artwork: artwork("full_health") },
  { id: "heavy_blow", tier: "common", hidden: false, title: "一击裂甲", description: "一次完整行动足以让最硬的防线失去形状。", criteria: "单个行动回合实际造成至少 3 点生命伤害。", teamScope: "both", order: 8, artwork: artwork("heavy_blow") },
  { id: "win_streak_three", tier: "rare", hidden: false, title: "连胜不息", description: "三场终局接踵而来，征旗始终迎风。", criteria: "连续赢得 3 场对局。", teamScope: "both", order: 1, artwork: artwork("win_streak_three") },
  { id: "double_blood", tier: "rare", hidden: false, title: "双杀", description: "两道敌影在同一场尘埃里同时沉寂。", criteria: "单场击杀至少 2 名敌人。", teamScope: "both", order: 2, artwork: artwork("double_blood") },
  { id: "rescue_chain", tier: "rare", hidden: false, title: "医术高超", description: "救援不靠侥幸，连续伸出的手把阵线稳住。", criteria: "单场成功救下至少 2 次濒死友军。", teamScope: "both", order: 3, artwork: artwork("rescue_chain") },
  { id: "damage_ten", tier: "rare", hidden: false, title: "十道战痕", description: "每一处伤口都写着你主动推进过的距离。", criteria: "单场累计造成至少 10 点实际生命伤害。", teamScope: "both", order: 5, artwork: artwork("damage_ten") },
  { id: "war_of_attrition", tier: "rare", hidden: false, title: "百炼", description: "痛楚没有把你从阵地上赶走。", criteria: "单场实际承受至少 5 点伤害。", teamScope: "both", order: 6, artwork: artwork("war_of_attrition") },
  { id: "flawless_victory", tier: "rare", hidden: false, title: "无人倒下", description: "整支队伍穿过终局，连一面同行的旗都没有折断。", criteria: "赢得对局且己方没有队友死亡。", teamScope: "both", order: 7, artwork: artwork("flawless_victory") },
  { id: "last_stand_duo", tier: "rare", hidden: false, title: "双人绝唱", description: "残局只剩两颗星，却仍让敌阵听见凯歌。", criteria: "二人小队形成 1v2 并最终获胜。", teamScope: "duo", order: 8, artwork: artwork("last_stand_duo") },
  { id: "self_lightning", tier: "rare", hidden: false, title: "害人终害己", description: "最危险的电光绕回原点，留下无法抵赖的印记。", criteria: "被自己主动释放的闪电击中。", teamScope: "both", order: 9, artwork: artwork("self_lightning") },
  { id: "single_punch", tier: "rare", hidden: false, title: "一拳", description: "一记落下，护甲与空气一同发出裂响。", criteria: "打出的一次攻击造成至少 3 点伤害。", teamScope: "both", order: 10, artwork: artwork("single_punch") },
  { id: "last_stand_duo_three", tier: "epic", hidden: false, title: "孤军破阵", description: "退路被三重敌影封死，仍有人从裂口杀出。", criteria: "二人小队形成 1v3 并最终获胜。", teamScope: "duo", order: 1, artwork: artwork("last_stand_duo_three") },
  { id: "executioner_turn", tier: "epic", hidden: false, title: "两刃同落", description: "同一个行动回合，两个破绽被你接连捕捉。", criteria: "同一行动回合击杀 2 名敌人。", teamScope: "both", order: 2, artwork: artwork("executioner_turn") },
  { id: "iron_wall_epic", tier: "epic", hidden: false, title: "千锤百炼", description: "火花落尽，承受过的每一道重击都把你的阵线铸得更坚硬。", criteria: "单场实际承受至少 8 点伤害。", teamScope: "both", order: 3, artwork: artwork("iron_wall_epic") },
  { id: "rescue_master", tier: "epic", hidden: false, title: "轮回天生", description: "三次从濒死边缘拉回同伴，援护变成了传说。", criteria: "单场成功救下至少 3 次濒死友军。", teamScope: "both", order: 4, artwork: artwork("rescue_master") },
  { id: "ace", tier: "epic", hidden: false, title: "ACE", description: "三枚敌方徽记被你亲手从战场上抹去。", criteria: "二人小队中玩家单场击杀全部敌人。", teamScope: "duo", order: 5, artwork: artwork("ace") },
  { id: "defeated_mvp", tier: "epic", hidden: false, title: "虽败犹荣", description: "战旗倒下之后，最亮的那枚徽记仍属于你。", criteria: "败方 MVP。", teamScope: "both", order: 6, artwork: artwork("defeated_mvp") },
  { id: "lightning_conductor", tier: "epic", hidden: false, title: "导电体质", description: "两次雷光穿过你的轮廓，仍没能夺走你的名字。", criteria: "单场对局被闪电实际击中至少 2 次。", teamScope: "both", order: 7, artwork: artwork("lightning_conductor") },
  { id: "radar_tactician", tier: "epic", hidden: false, title: "算命大师", description: "雷达扇面张开五次，战术的征兆都被你看见。", criteria: "单局雷达判定累计 5 次判定为战术牌。", teamScope: "both", order: 8, artwork: artwork("radar_tactician") },
  { id: "energy_twenty_five", tier: "epic", hidden: false, title: "E=MC^2", description: "能量在你手中聚成一枚足以撼动战局的核心。", criteria: "一局使用至少 25 点能量。", teamScope: "both", order: 9, artwork: artwork("energy_twenty_five") },
  { id: "survivor_thirteen", tier: "epic", hidden: false, title: "持久战", description: "时间越过第十二道刻度，你仍守在自己的阵线上。", criteria: "存活超过 12 回合。", teamScope: "both", order: 10, artwork: artwork("survivor_thirteen") },
  { id: "last_stand_trio", tier: "legendary", hidden: false, title: "逆境三人行", description: "三人的阵线倒转成孤锋，也能把绝境走成胜局。", criteria: "三人小队形成 1v2 并最终获胜。", teamScope: "trio", order: 1, artwork: artwork("last_stand_trio") },
  { id: "score_over_thousand", tier: "legendary", hidden: false, title: "破千", description: "终局落幕时，战场为你的表现留下了高耸刻度。", criteria: "单场最终个人成绩严格大于 1000 分。", teamScope: "both", order: 2, artwork: artwork("score_over_thousand") },
  { id: "mvp_streak_ten", tier: "legendary", hidden: false, title: "冠冕长明", description: "十场终局的掌声，始终落在你的名字上。", criteria: "连续 10 场成为 MVP。", teamScope: "both", order: 3, artwork: artwork("mvp_streak_ten") },
  { id: "defeated_mvp_streak", tier: "legendary", hidden: false, title: "悲情英雄", description: "两次败局都留下你的冠冕，遗憾也能铸成荣光。", criteria: "连续 2 场成为败方 MVP。", teamScope: "both", order: 4, artwork: artwork("defeated_mvp_streak") },
  { id: "serious_punch", tier: "legendary", hidden: false, title: "认真的一拳", description: "这一击的回声穿过整座战场，连岩壁都为之震动。", criteria: "打出的一次攻击造成至少 5 点伤害。", teamScope: "both", order: 5, artwork: artwork("serious_punch") },
  { id: "damage_taken_twelve", tier: "legendary", hidden: false, title: "不死之身", description: "重击如雨，你的核心却始终没有熄灭。", criteria: "单场实际承受至少 12 点伤害。", teamScope: "both", order: 6, artwork: artwork("damage_taken_twelve") },
  { id: "card_creator", tier: "legendary", hidden: false, title: "造物主", description: "牌页在你手中汇成壮阔的构造，仿佛一座新世界。", criteria: "单场获取超过 100 张牌。", teamScope: "both", order: 7, artwork: artwork("card_creator") },
  { id: "battle_over_eighteen", tier: "legendary", hidden: false, title: "战斗~爽", description: "战线延伸到第十九道刻度，意志仍在燃烧。", criteria: "存活超过 18 回合。", teamScope: "both", order: 8, artwork: artwork("battle_over_eighteen") },
  { id: "storm_scribe", tier: "hidden", hidden: true, title: "雷神", description: "闪电掠过敌阵，留下两道无法忽视的回声。", criteria: "单场主动打出至少 2 次闪电，且两次都实际对敌人造成闪电伤害。", teamScope: "both", order: 1, artwork: artwork("storm_scribe") },
  { id: "overflowing_grimoire", tier: "hidden", hidden: true, title: "收藏家", description: "你喜欢收藏奇珍异宝，成为了名副其实的大收藏家。", criteria: "自己的一个行动回合中，手牌数量曾不少于 10 张", teamScope: "both", order: 2, artwork: artwork("overflowing_grimoire") },
  { id: "armory_keeper", tier: "hidden", hidden: true, title: "兵库尽开", description: "一件件装备在手中轮转，最终铸成自己的军械谱。", criteria: "单场实际完成装备动作至少 10 次。", teamScope: "both", order: 3, artwork: artwork("armory_keeper") },
  { id: "all_rounder", tier: "hidden", hidden: true, title: "全能神", description: "六边形无法束缚你的完美，此刻你已然化身神明。", criteria: "单场最终个人成绩中的所有计分项目都达到 100 分或更高。", teamScope: "both", order: 4, artwork: artwork("all_rounder") },
  { id: "accidental_success", tier: "hidden", hidden: true, title: "歪打正着", description: "没有突袭的锋芒，你仍让全场火力刻度停在自己名下。", criteria: "全程未打出突袭并成为全场最高火力者。", teamScope: "both", order: 5, artwork: artwork("accidental_success") }
];

export const ACHIEVEMENT_TIERS = Object.freeze(["common", "rare", "epic", "legendary", "hidden"]);
export const ACHIEVEMENT_DEFINITIONS = Object.freeze(definitions.map((definition) => Object.freeze(definition)));

/*
功能
按公开稳定顺序排列成就定义。

调用方
AchievementStore 与成就视图。

输入
任意成就定义数组。

输出
新的稳定排序数组。

读取状态
ACHIEVEMENT_TIERS、definition.order、definition.id。

写入状态
无。

调用函数
Array.sort。

边界与不变量
不修改调用方数组；未知 tier 排在已知 tier 之后。
*/
export function sortAchievements(definitionsToSort = ACHIEVEMENT_DEFINITIONS) {
  return [...definitionsToSort].sort((left, right) => {
    const tierOrder = ACHIEVEMENT_TIERS.indexOf(left.tier) - ACHIEVEMENT_TIERS.indexOf(right.tier);
    return tierOrder || (Number(left.order) || 0) - (Number(right.order) || 0) || String(left.id).localeCompare(String(right.id));
  });
}
