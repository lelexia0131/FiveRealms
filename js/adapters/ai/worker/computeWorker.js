/*
模块职责
纯 Compute Worker 的 INIT/COMPUTE 协议入口。

上游
ComputeWorkerPool。

下游
Controller public candidate composition。

状态边界
只持有当前 generation 的纯计算组合。

信息边界
只接收过滤后的 World 与 Coordinator 已生成的隐藏样本。

架构约束
不构造 Searcher，不拥有 RNG/Budget/Beam；错误必须返回 ERROR。
*/
import { createCandidateCompute } from "../../../ai/Controller.js";

/*
功能
创建独立的纯计算消息处理器。

调用方
浏览器 Worker entry 与 Node worker-thread 测试。

输入
postMessage 能力。

输出
同步 handleMessage；每条合法请求有唯一 terminal。

读取状态
无。

写入状态
闭包中的 generation 与 candidate compute。

调用函数
createCandidateCompute。

边界与不变量
不读取全局随机源，不做 local retry。
*/
export function createComputeWorkerMessageHandler({ postMessage }) {
  let generation = null;
  let compute = null;
  /*
  功能
  计算一个已 admission 的 candidate 并返回完整回执。

  调用方
  Worker onmessage。

  输入
  INIT/COMPUTE 及 generation/batchId/canonicalIndex。

  输出
  READY、RESULT 或 ERROR。

  读取状态
  当前 generation 与纯计算组合。

  写入状态
  INIT 替换组合；COMPUTE 只写私有 Worlds。

  调用函数
  createCandidateCompute、CandidateCompute.compute、postMessage。

  边界与不变量
  不接受旧 generation；不返回部分 candidate 或 fallback。
  */
  function handleMessage(message) {
    const identity = { generation:message.generation, batchId:message.batchId, canonicalIndex:message.canonicalIndex };
    try {
      if (message.type === "INIT") {
        compute = createCandidateCompute(message.composition);
        generation = message.generation;
        postMessage({ ...identity, type:"READY" });
        return;
      }
      if (message.type !== "COMPUTE" || !compute || generation !== message.generation) {
        throw new Error("Invalid compute generation or message");
      }
      const receipt = compute.compute(message.input);
      postMessage({ ...identity, type:"RESULT", receipt });
    } catch (error) {
      postMessage({ ...identity, type:"ERROR", error:{ name:error.name || "Error", message:error.message || String(error) } });
    }
  }
  return { handleMessage };
}

if (typeof self !== "undefined") {
  const handler = createComputeWorkerMessageHandler({ postMessage:data => self.postMessage(data) });
  self.onmessage = event => handler.handleMessage(event.data);
}
