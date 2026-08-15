/*
模块职责
集中暴露跨 value/search owner（某项数值的唯一归属模块）的只读查询，并把每个调用透明转发给唯一公式实现。

上游
AIController、响应策略与直接价值查询测试。

下游
显式注入的 Evaluator、StateValue、ValueLedger、SimulationQuery、FrontierValue 与 SearchPrior。

状态边界
只保存显式服务引用；不持有 Game，不读写 GameState。

信息边界
由各正式归属模块执行其 VisibleState/SearchState 与合法记忆边界。

架构约束
本文件不得保留价值公式、导入 Simulator 或成为新的组合根（统一组装依赖的位置）；只允许无损转发。
*/
import * as CardValue from "./CardValue.js?build=20260815-shadow-agent-p1-slot";
import * as Economics from "./Economics.js?build=20260815-shadow-agent-p1-slot";
import * as ThreatValue from "./ThreatValue.js?build=20260815-shadow-agent-p1-slot";

export {
  HP_VALUE,
  STATE_DELTA_SCALE
} from "./Economics.js?build=20260815-shadow-agent-p1-slot";
export { HP_RISK_OPTION_WEIGHT } from "./ThreatValue.js?build=20260815-shadow-agent-p1-slot";

const OWNER_METHODS = Object.freeze([
  ["evaluator", ["playerValueTerms", "ownerStateTerms", "ownerMaterialValue"]],
  ["stateValue", ["stateUtility"]],
  ["simulationQuery", [
    "lightningLifecycleOwnerDeltas",
    "lightningLifecycleValue",
    "lightningTeamBurden",
    "lightningTransferredBurden",
    "lightningOwnerDelta"
  ]],
  ["valueLedger", ["ownerStateLedger", "projectOwnerLedger"]],
  ["frontierValue", ["frontierResidual"]],
  ["searchPrior", [
    "breakArmyUtility",
    "threatPriority",
    "actionUtility",
    "symbiosisNetFromState",
    "actionSearchPrior"
  ]]
]);

/*
功能
把正式归属模块的方法绑定到正式边界实例。

调用方
ValueService 构造函数。

输入
目标服务、owner 实例和方法名数组。

输出
无；缺失正式方法时抛出异常。

读取状态
只读 owner 方法。

写入状态
写入服务实例上的 bound method 字段。

调用函数
Function.bind。

边界与不变量
只转发调用，不包裹或改写参数、返回值和数值公式。
*/
function bindOwnerMethods(target, owner, methodNames) {
  for (const methodName of methodNames) {
    if (typeof owner?.[methodName] !== "function") {
      throw new Error(`ValueService 缺少价值 owner 方法：${methodName}`);
    }
    target[methodName] = owner[methodName].bind(owner);
  }
}

export class ValueService {
  /*
  功能
  组装不含价值公式的统一 ValueService 查询边界。

  调用方
  AIController 组合根（统一组装依赖的位置）。

  输入
  已由 Controller 构造的全部正式 value/search owner。

  输出
  具有稳定查询方法的 ValueService 实例。

  读取状态
  只保存显式服务引用与纯模块函数。

  写入状态
  写入实例服务字段和绑定方法。

  调用函数
  bindOwnerMethods、Function.bind。

  边界与不变量
  不接受或持有 Game；所有公式只存在于正式 owner，本服务不得出现第二份实现。
  */
  constructor({
    evaluator,
    stateValue,
    simulationQuery,
    valueLedger,
    frontierValue,
    searchPrior,
    transitionValue
  }) {
    Object.assign(this, {
      stateEvaluator: evaluator,
      stateValue,
      simulationQuery,
      valueLedger,
      frontierValue,
      searchPrior,
      transitionValue
    });
    const owners = {
      evaluator,
      stateValue,
      simulationQuery,
      valueLedger,
      frontierValue,
      searchPrior
    };
    for (const [ownerName, methodNames] of OWNER_METHODS) {
      bindOwnerMethods(this, owners[ownerName], methodNames);
    }
    bindOwnerMethods(this, CardValue, [
      "roleCardDelta",
      "cardAvailability",
      "cardOpportunityCost"
    ]);
    bindOwnerMethods(this, ThreatValue, [
      "exposureComponents",
      "incomingExposure",
      "radarMitigationUtility",
      "hp2ThreatRiskValue",
      "shieldStateValue"
    ]);
    bindOwnerMethods(this, Economics, ["actionEconomicValue"]);
    this.energyDeviceFutureUtility = Economics.energyDeviceFutureUtility.bind(
      null,
      evaluator.energyRules
    );
  }
}
