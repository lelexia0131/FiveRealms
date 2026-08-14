/*
模块职责
保留转移评分的历史导入路径，并透明重导出正式 TransferPolicy owner。

上游
AiCardSelector、AiActionGenerator、测试与迁移期调用方。

下游
policy/TransferPolicy。

状态边界
不读取或写入状态。

信息边界
不新增未知实体定义入口。

架构约束
本文件不得保留第二份转移评分、候选生成或选择实现。
*/
export {
  MIN_TRANSFER_UTILITY,
  UNKNOWN_HAND_EXPECTED_VALUE,
  buildTransferCandidates,
  cardSituationValue,
  chooseBestPositiveTransfer,
  chooseTransferHandCandidate,
  expectedHandValue,
  scoreTransferCombination,
  threatView
} from "./policy/TransferPolicy.js?build=20260814-ai-simulation-engine";
