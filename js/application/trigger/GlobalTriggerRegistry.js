/*
模块职责
唯一拥有全局状态 trigger registration：huntMark source-death cleanup、sealed 与 lightning beforeStatusResolve bridges。不拥有 status/judgment workflow 或 EventDispatcher dispatcher implementation。

上游
composition root。

下游
Application Dying/Judgment workflows 与 messaging subscription capability。

状态边界
不写 Domain state；只注册 listeners。

信息边界
不读取 hidden info；listener 只读取 event 公开持有者/状态。

架构约束
不得依赖 Game、UIManager、AIController、SoundManager、EventDispatcher runtime 或 concrete adapters。
*/
const REQUIRED_DEPENDENCIES = ["onEvent", "getState", "cleanupHuntMarksForSource", "resolveSeal", "resolveLightning"];

/*
功能
创建全局状态 trigger registry。

调用方
match application.registerGlobalRules bridge。

输入
注入的 subscription 与 workflow capabilities。

输出
冻结 { register }。

读取状态
无。

写入状态
listener registration。

调用函数
无。

边界与不变量
不重新实现 seal/lightning/huntMark 语义；只转发既有 Application workflows。
*/
export function createGlobalTriggerRegistry(dependencies) {
  for (const name of REQUIRED_DEPENDENCIES) {
    if (!dependencies?.[name]) throw new TypeError(`GlobalTriggerRegistry 缺少 ${name} collaborator`);
  }
  const runtime = dependencies;

  /*
  功能
  注册 playerDead 与 beforeStatusResolve bridges。

  调用方
  match application boundary。

  输入
  无。

  输出
  无。

  读取状态
  无。

  写入状态
  listener registration。

  调用函数
  onEvent。

  边界与不变量
  key 与既有 registerGlobalRules public boundary 完全一致。
  */
  function register() {
    runtime.onEvent("playerDead", "global:huntMarkSourceCleanup", (event) => {
      runtime.cleanupHuntMarksForSource(event.target.id);
    });
    runtime.onEvent("beforeStatusResolve", "global:seal", async (event) => {
      const holder = event.player;
      const status = holder?.statuses?.sealed;
      if (!status || event.cancelled || !holder?.alive || runtime.getState().isGameOver) return;
      await runtime.resolveSeal(holder, status);
    });
    runtime.onEvent("beforeStatusResolve", "global:lightning", async (event) => {
      const holder = event.player;
      const status = holder?.statuses?.lightning;
      if (!status || event.cancelled || !holder?.alive || runtime.getState().isGameOver) return;
      await runtime.resolveLightning(holder, status);
    });
  }

  return Object.freeze({ register });
}
