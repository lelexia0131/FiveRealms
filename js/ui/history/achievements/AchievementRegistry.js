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
  { id: "first_victory", tier: "common", hidden: false, title: "初见凯旋", description: "第一次把胜利带回档案馆。", criteria: "赢得至少一场对局。", teamScope: "both", order: 1, artwork: artwork("first_victory") },
  { id: "skill_trinity", tier: "common", hidden: false, title: "三次回响", description: "主动技能在战场上留下连续回声。", criteria: "单场主动技能使用次数达到 3 次。", teamScope: "both", order: 2, artwork: artwork("skill_trinity") },
  { id: "first_blood", tier: "common", hidden: false, title: "破阵之刃", description: "第一道敌阵裂口由你亲手打开。", criteria: "单场击杀至少 1 名敌人。", teamScope: "both", order: 3, artwork: artwork("first_blood") },
  { id: "rescue_beacon", tier: "common", hidden: false, title: "回生之光", description: "从濒死边缘把同伴带回战场。", criteria: "单场成功救下至少 1 名濒死友军。", teamScope: "both", order: 4, artwork: artwork("rescue_beacon") },
  { id: "win_streak_three", tier: "rare", hidden: false, title: "不息征旗", description: "三场胜利连成一面不坠的旗。", criteria: "连续赢得 3 场对局。", teamScope: "both", order: 1, artwork: artwork("win_streak_three") },
  { id: "double_blood", tier: "rare", hidden: false, title: "双重裂痕", description: "一场战斗中让两名敌人倒下。", criteria: "单场击杀至少 2 名敌人。", teamScope: "both", order: 2, artwork: artwork("double_blood") },
  { id: "rescue_chain", tier: "rare", hidden: false, title: "援手不绝", description: "在同一场战斗里多次点亮回生之光。", criteria: "单场成功救下至少 2 名濒死友军。", teamScope: "both", order: 3, artwork: artwork("rescue_chain") },
  { id: "heavy_blow", tier: "rare", hidden: false, title: "破甲一击", description: "一个行动回合打穿三点真实生命。", criteria: "单个行动回合实际造成至少 3 点生命伤害。", teamScope: "both", order: 4, artwork: artwork("heavy_blow") },
  { id: "damage_ten", tier: "rare", hidden: false, title: "战痕纵横", description: "一场征途中积累十点真实伤害。", criteria: "单场累计造成至少 10 点实际生命伤害。", teamScope: "both", order: 5, artwork: artwork("damage_ten") },
  { id: "war_of_attrition", tier: "rare", hidden: false, title: "百炼之躯", description: "承受战场的重压仍不退后。", criteria: "单场实际承受至少 5 点伤害。", teamScope: "both", order: 6, artwork: artwork("war_of_attrition") },
  { id: "flawless_victory", tier: "rare", hidden: false, title: "无损凯歌", description: "胜利时，同行者没有一人倒下。", criteria: "赢得对局且己方没有队友死亡。", teamScope: "both", order: 7, artwork: artwork("flawless_victory") },
  { id: "last_stand_duo", tier: "rare", hidden: false, title: "双星孤行", description: "二人小队在一对二的残局中夺回胜利。", criteria: "二人小队形成 1v2 并最终获胜。", teamScope: "duo", order: 8, artwork: artwork("last_stand_duo") },
  { id: "last_stand_duo_three", tier: "epic", hidden: false, title: "逆潮独行", description: "二人小队以一人之身迎战三名敌人并凯旋。", criteria: "二人小队形成 1v3 并最终获胜。", teamScope: "duo", order: 1, artwork: artwork("last_stand_duo_three") },
  { id: "executioner_turn", tier: "epic", hidden: false, title: "断界连斩", description: "一个行动回合中连续斩落两名敌人。", criteria: "同一行动回合连续击杀 2 名敌人。", teamScope: "both", order: 2, artwork: artwork("executioner_turn") },
  { id: "iron_wall_epic", tier: "epic", hidden: false, title: "残垣不倒", description: "承受八点真实伤害后仍守住阵线。", criteria: "单场实际承受至少 8 点伤害。", teamScope: "both", order: 3, artwork: artwork("iron_wall_epic") },
  { id: "rescue_master", tier: "epic", hidden: false, title: "群星援护", description: "三次把濒死的同伴从深渊拉回。", criteria: "单场成功救下至少 3 名濒死友军。", teamScope: "both", order: 4, artwork: artwork("rescue_master") },
  { id: "last_stand_trio", tier: "legendary", hidden: false, title: "三曜孤锋", description: "三人小队在一对二的绝境中赢下终局。", criteria: "三人小队形成 1v2 并最终获胜。", teamScope: "trio", order: 1, artwork: artwork("last_stand_trio") },
  { id: "score_over_thousand", tier: "legendary", hidden: false, title: "千分铭刻", description: "个人终局表现越过千分界碑。", criteria: "单场最终个人成绩严格大于 1000 分。", teamScope: "both", order: 2, artwork: artwork("score_over_thousand") },
  { id: "mvp_streak_ten", tier: "legendary", hidden: false, title: "冠冕长明", description: "十场终局，王冠始终戴在你头上。", criteria: "连续 10 场成为 MVP。", teamScope: "both", order: 3, artwork: artwork("mvp_streak_ten") },
  { id: "storm_scribe", tier: "hidden", hidden: true, title: "雷痕铭记者", description: "让两道真正的闪电在敌阵留下伤痕。", criteria: "单场主动打出至少 2 次闪电，且两次都实际对敌人造成闪电伤害。", teamScope: "both", order: 1, artwork: artwork("storm_scribe") },
  { id: "overflowing_grimoire", tier: "hidden", hidden: true, title: "满页秘典", description: "让手中的卷页短暂越过常理。", criteria: "自己的一个行动回合中手牌数量曾超过 15 张。", teamScope: "both", order: 2, artwork: artwork("overflowing_grimoire") },
  { id: "armory_keeper", tier: "hidden", hidden: true, title: "万械归藏", description: "让十件装备在你的征途中真正落位。", criteria: "单场实际完成装备动作至少 10 次。", teamScope: "both", order: 3, artwork: artwork("armory_keeper") }
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
