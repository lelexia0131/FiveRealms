import { parentPort } from "node:worker_threads";
import { createSearchWorkerMessageHandler } from "../js/adapters/ai/worker/searchWorker.js";
import { Simulator } from "../js/ai/Simulator/Simulator.js";

// 测试线程只给正式 protocol 加计数；不实现另一个 AI executor。
let counts = {};
for (const name of ["buildRootFlipWorlds", "buildFutureResourceSelectionWorlds", "buildLightningOutcomeSets", "buildLightningOutcomeWorlds", "apply", "clone"]) {
  const original = Simulator.prototype[name];
  Simulator.prototype[name] = function (...args) {
    counts[name] = (counts[name] ?? 0) + 1;
    return original.apply(this, args);
  };
}
const handler = createSearchWorkerMessageHandler({
  postMessage(message) {
    if (message.type === "RESULT") message.outcome.testCounts = { ...counts };
    parentPort.postMessage(message);
  }
});
parentPort.on("message", message => {
  if (message.type !== "CANCEL") counts = {};
  handler.handleMessage(message);
});
