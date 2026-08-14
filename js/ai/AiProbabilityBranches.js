/*
模块职责
保留通用概率工具与雷达领域模型的历史导入路径。

上游
历史测试与尚未迁移的外部调用方。

下游
state/Probability 与 domain/RadarModel。

状态边界
无状态；仅重导出正式 owner。

信息边界
不增加任何输入或隐藏信息来源。

架构约束
不得复制概率或雷达算法；新生产调用方应直接导入正式 owner。
*/
export * from "./state/Probability.js?build=20260814-ai-simulation-engine";
export {
  RADAR_BASIC_DEFINITIONS,
  buildRadarJudgmentProbabilities
} from "./domain/RadarModel.js?build=20260814-ai-simulation-engine";
