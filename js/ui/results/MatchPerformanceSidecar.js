import { MatchPerformanceTracker } from "./MatchPerformanceTracker.js";
import { createMatchResultViewModel } from "./MatchResultViewModel.js";

/*
功能
安装一局 presentation-sidecar observer，并在 gameOver 时一次性派生和展示 immutable 结果。

调用方
createGameApplication composition root。

输入
EventDispatcher、authoritative state getter 与结果展示 callback。

输出
冻结的 { tracker, dispose } sidecar handle。

读取状态
仅通过 tracker 在事件发生后读取公开真实 MatchState。

写入状态
只写 sidecar tracker；结果通过 onResult 交给 UI。

调用函数
MatchPerformanceTracker、createMatchResultViewModel、EventDispatcher.on。

边界与不变量
不参与规则/结算/AI；运行期只累计 raw facts，gameOver 只 derive/sort/render 一次。
*/
export function createMatchPerformanceSidecar({ eventDispatcher, getState, onResult }) {
  const tracker = new MatchPerformanceTracker({ eventDispatcher, getState }).start();
  const unsubscribeGameOver = eventDispatcher.on(
    "gameOver",
    "match-performance:finalize",
    () => onResult(createMatchResultViewModel(tracker.finalizeMatch()))
  );
  return Object.freeze({
    tracker,
    /*
    功能
    取消 gameOver 与 tracker 的全部观察订阅。

    调用方
    MatchApplication.dispose。

    输入
    无。

    输出
    无返回值。

    读取状态
    sidecar subscription handles。

    写入状态
    EventDispatcher listener registry 与 tracker raw state。

    调用函数
    unsubscribeGameOver、tracker.dispose。

    边界与不变量
    重复调用安全，不写真实对局状态。
    */
    dispose() {
      unsubscribeGameOver();
      tracker.dispose();
    }
  });
}
