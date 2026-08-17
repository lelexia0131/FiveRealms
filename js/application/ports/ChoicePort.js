/*
模块职责
定义 Application Choice 的 data-only port contract：request 只接受 ChoiceRequest，只返回 canonical ChoiceResult。

上游
application/choice 协调器与 composition root。

下游
adapters/ui 与 adapters/ai 的 peer choice adapter。

状态边界
不读取或写入任何运行时状态。

信息边界
不得包含 Game/Player/Card/DOM/AI search node；只允许可序列化 IDs、tokens、primitive metadata。

架构约束
不得依赖 UI/AI/Audio/Diagnostics 实现、Game runtime、Domain transitions 或 EventDispatcher runtime。
*/

export const CHOICE_STATUS = Object.freeze({
  SELECTED: "selected",
  DECLINED: "declined",
  CANCELLED: "cancelled"
});

const CHOICE_STATUS_VALUES = new Set(Object.values(CHOICE_STATUS));

/*
功能
创建规范化 ChoiceResult。

调用方
ChoicePort adapters、ChoiceCoordinator 与 tests。

输入
status 与可选 payload。

输出
冻结的 { status, selectedIds, reason }。

读取状态
无。

写入状态
无。

调用函数
Object.freeze。

边界与不变量
selectedIds 只允许字符串数组；未提供时为空冻结数组。
*/
export function createChoiceResult(status, payload = {}) {
  if (!CHOICE_STATUS_VALUES.has(status)) {
    throw new TypeError(`未知 ChoiceResult status：${status}`);
  }
  const selectedIds = Array.isArray(payload.selectedIds)
    ? payload.selectedIds.filter((id) => typeof id === "string")
    : [];
  return Object.freeze({
    status,
    selectedIds: Object.freeze(selectedIds),
    reason: typeof payload.reason === "string" ? payload.reason : null
  });
}

/*
功能
把 decision shape 或 canonical result 归一化为 ChoiceResult。

调用方
ChoiceCoordinator 与 adapters。

输入
/canonical result。

输出
冻结 canonical ChoiceResult。

读取状态
无。

写入状态
无。

调用函数
createChoiceResult。

边界与不变量
used -> selected；declined/cancelled 直通；boolean true/false 兼容。
*/
export function normalizeChoiceResult(result) {
  if (result?.status === CHOICE_STATUS.SELECTED || result?.status === CHOICE_STATUS.DECLINED || result?.status === CHOICE_STATUS.CANCELLED) {
    return createChoiceResult(result.status, result);
  }
  if (result?.status === "used") {
    return createChoiceResult(CHOICE_STATUS.SELECTED, {
      selectedIds: result.cardId ? [result.cardId] : []
    });
  }
  if (result?.status === "declined" || result === false) return createChoiceResult(CHOICE_STATUS.DECLINED);
  if (result?.status === "cancelled" || result === null) return createChoiceResult(CHOICE_STATUS.CANCELLED);
  return createChoiceResult(Boolean(result) ? CHOICE_STATUS.SELECTED : CHOICE_STATUS.DECLINED);
}

/*
功能
验证并冻结一个 ChoicePort implementation。

调用方
application/choice、composition root 与 tests。

输入
含 async request(choiceRequest) 的 implementation 对象。

输出
冻结 ChoicePort。

读取状态
无。

写入状态
无。

调用函数
Object.freeze。

边界与不变量
不创建无行为抽象 class；不实现 routing 或规则。
*/
export function createChoicePort(implementation) {
  if (!implementation || typeof implementation.request !== "function") {
    throw new TypeError("ChoicePort implementation 必须提供 request(choiceRequest)");
  }
  return Object.freeze({ request: implementation.request });
}
