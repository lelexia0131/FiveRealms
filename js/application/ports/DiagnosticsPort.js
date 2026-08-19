/*
模块职责
定义 Application 的 minimal Diagnostics boundary：伤害、治疗与失去生命三类 runtime telemetry；玩家可见日志不属本 port。

上游
application/combat 与 composition root。

下游
concrete diagnostics adapter（当前由 MatchApplication composition 桥接）。

状态边界
只接收 data-only telemetry DTO；不读写真 GameState。

信息边界
只允许 ID、数值与 semantic type；不暴露 Player.statistics 对象或 AI memory。

架构约束
不得依赖 concrete Diagnostics adapter、Game runtime、Domain transitions、EventDispatcher、UI 或 AI。
*/

const REQUIRED_METHODS = [
  "recordDamage",
  "recordHealing",
  "recordHpLoss",
  "recordCardPlayed",
  "recordAssaultUse",
  "reportWorkflowError"
];

/*
功能
验证并冻结一个 DiagnosticsPort implementation。

调用方
MatchApplication composition root 与 tests。

输入
含 recordDamage/recordHealing/recordHpLoss 的 implementation。

输出
冻结 DiagnosticsPort。

读取状态
无。

写入状态
无。

调用函数
Object.freeze。

边界与不变量
不暴露整个 Player.statistics；workflow error 只表达稳定 trace semantic。
*/
export function createDiagnosticsPort(implementation) {
  if (!implementation) throw new TypeError("DiagnosticsPort 需要 implementation");
  for (const method of REQUIRED_METHODS) {
    if (typeof implementation[method] !== "function") {
      throw new TypeError(`DiagnosticsPort 缺少 ${method}()`);
    }
  }
  return Object.freeze({
    recordDamage: implementation.recordDamage,
    recordHealing: implementation.recordHealing,
    recordHpLoss: implementation.recordHpLoss,
    recordCardPlayed: implementation.recordCardPlayed,
    recordAssaultUse: implementation.recordAssaultUse,
    reportWorkflowError: implementation.reportWorkflowError
  });
}
