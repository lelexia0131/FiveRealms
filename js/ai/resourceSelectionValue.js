/*
模块职责
保留破坏/掠夺资源选择的历史导入路径，并重导出正式 ResourceSelectionPolicy owner。

上游
AiSimulator、AiCardSelector、测试与迁移期调用方。

下游
policy/ResourceSelectionPolicy。

状态边界
不读取或写入状态。

信息边界
不新增未知实体定义入口。

架构约束
本文件不得保留第二份资源效用或区域选择实现。
*/
export {
  chooseBestResourceHandCandidate,
  chooseResourceZone,
  getResourceDefinitionUtility,
  getResourceUnknownUtility
} from "./policy/ResourceSelectionPolicy.js?build=20260814-ai-simulation-engine";
