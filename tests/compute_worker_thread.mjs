import { parentPort } from "node:worker_threads";
import { createComputeWorkerMessageHandler } from "../js/adapters/ai/worker/computeWorker.js";

const handler = createComputeWorkerMessageHandler({ postMessage:message => parentPort.postMessage(message) });
parentPort.on("message", message => handler.handleMessage(message));
