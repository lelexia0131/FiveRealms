/*
模块职责
最小 Choice 协调器：把已构造的 ChoiceRequest 交给注入的 ChoicePort，并归一化结果；不拥有游戏规则、routing 或 workflow。

上游
ResponseSystem 与 future application workflow。

下游
application/ports/ChoicePort。

状态边界
不读写真 GameState；不写 Domain state。

信息边界
只处理 data-only request/result。

架构约束
不得依赖 concrete UI/AI/Audio/Diagnostics、Game runtime、EventBus 或 adapters。
*/
import { normalizeChoiceResult } from "../ports/ChoicePort.js?build=20260815-shadow-agent-p1-slot";

/*
功能
创建最小 ChoiceCoordinator。

调用方
composition root 与 legacy ResponseSystem。

输入
已注入的 ChoicePort。

输出
冻结的 { request } 协调器。

读取状态
无。

写入状态
无。

调用函数
normalizeChoiceResult。

边界与不变量
不决定 legality；不修改 rule；adapter 返回 legacy shape 时只做 canonical mapping。
*/
export function createChoiceCoordinator(choicePort) {
  if (!choicePort || typeof choicePort.request !== "function") {
    throw new TypeError("ChoiceCoordinator 必须注入有效 ChoicePort");
  }
  return Object.freeze({
    /*
    功能
    请求已注入 ChoicePort 并返回 canonical ChoiceResult。

    调用方
    ResponseSystem 与 future application workflow。

    输入
    data-only ChoiceRequest。

    输出
    Promise<canonical ChoiceResult>。

    读取状态
    无。

    写入状态
    无。

    调用函数
    choicePort.request、normalizeChoiceResult。

    边界与不变量
    不决定 legality、不写 Domain state、不做 routing。
    */
    async request(choiceRequest) {
      return normalizeChoiceResult(await choicePort.request(choiceRequest));
    }
  });
}
