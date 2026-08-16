/*
模块职责
把 Application DiagnosticsPort 的 runtime telemetry DTO bridge 到 legacy Player.statistics 字段；只拥有 concrete statistics adapter，不拥有 telemetry semantics。

上游
Game temporary composition root。

下游
application/ports/DiagnosticsPort。

状态边界
只写 legacy Player.statistics；不写 Domain fields、aiMemory 或 UI。

信息边界
只接收 playerId/amount DTO。

架构约束
不得依赖 Game class、AI、UI、Domain transitions 或其它 adapter。
*/
import { createDiagnosticsPort } from "../../application/ports/DiagnosticsPort.js?build=20260815-shadow-agent-p1-slot";
import { Debug } from "../../utils/debug.js?build=20260815-shadow-agent-p1-slot";

/*
功能
创建单局 concrete DiagnosticsPort adapter。

调用方
Game temporary composition root。

输入
getPlayerById 能力。

输出
冻结 DiagnosticsPort。

读取状态
getPlayerById。

写入状态
legacy Player.statistics。

调用函数
createDiagnosticsPort。

边界与不变量
保留旧 statistics 更新位置与数值语义；不暴露整个 Player.statistics。
*/
export function createPlayerStatisticsDiagnosticsAdapter({ getPlayerById }) {
  if (typeof getPlayerById !== "function") {
    throw new TypeError("PlayerStatisticsDiagnosticsAdapter 缺少 getPlayerById capability");
  }
  return createDiagnosticsPort({
    recordDamage: ({ targetId, sourceId, hpDamage }) => {
      const target = getPlayerById(targetId);
      if (target) target.statistics.damageTaken += hpDamage;
      const source = sourceId ? getPlayerById(sourceId) : null;
      if (source) source.statistics.damageDealt += hpDamage;
    },
    recordHealing: ({ sourceId, actualAmount }) => {
      const source = sourceId ? getPlayerById(sourceId) : null;
      if (source) source.statistics.healingDone += actualAmount;
    },
    recordHpLoss: ({ targetId, amount }) => {
      const target = getPlayerById(targetId);
      if (target) target.statistics.damageTaken += amount;
    },
    recordCardPlayed: ({ sourceId }) => {
      const source = getPlayerById(sourceId);
      if (source) source.statistics.cardsPlayed += 1;
    },
    recordAssaultUse: ({ sourceId }) => {
      const source = getPlayerById(sourceId);
      if (source) source.statistics.assaultsUsed += 1;
    },
    reportWorkflowError: (channel, message, error = null) => {
      Debug.log(channel, message, error ?? undefined);
    }
  });
}
