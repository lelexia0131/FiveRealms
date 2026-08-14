/*
模块职责
保留历史 AiKnowledge 导入路径并转发到 state/Knowledge 的唯一实现。

上游
AIController、现有测试与尚未迁移的 AI 模块。

下游
state/Knowledge。

状态边界
本文件不读写状态。

信息边界
由 state/Knowledge 统一执行合法私有记忆边界。

架构约束
不得复制 Knowledge 或 Belief 逻辑，只允许兼容重导出。
*/
export { AiKnowledge, createKnowledgeState } from "./state/Knowledge.js?build=20260814-ai-value-ownership";
