/*
模块职责
保留弃牌策略的历史导入路径，并透明重导出正式 ResourceSelectionPolicy owner。

上游
AiSimulator、AiCardSelector、测试与迁移期调用方。

下游
policy/ResourceSelectionPolicy。

状态边界
不读取或写入状态。

信息边界
不新增隐藏信息入口。

架构约束
本文件不得保留第二份评分或选择实现。
*/
export {
  RESPONSE_SURVIVAL_BONUS_DANGER,
  RESPONSE_SURVIVAL_BONUS_LETHAL,
  chooseDiscardCandidates,
  getDiscardKeepValue,
  rankDiscardCandidates
} from "./policy/ResourceSelectionPolicy.js?build=20260814-ai-policy-domain";
