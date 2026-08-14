/*
模块职责
保留历史 AiSimulator 导入名，并把所有构造与静态访问透明转交唯一正式 Simulator。

上游
历史测试与迁移期调用方。

下游
simulation/Simulator。

状态边界
不持有状态，不创建包装实例。

信息边界
不读取任何 GameState、SearchState 或隐藏信息。

架构约束
只允许重导出，不得保留或复制模拟算法。
*/
export { Simulator, Simulator as AiSimulator } from "./simulation/Simulator.js?build=20260814-ai-simulation-engine";
