import { MATCH_PERFORMANCE_LABELS } from "./MatchPerformancePolicy.js";

export const MATCH_PERFORMANCE_RADAR_AXIS_ORDER = Object.freeze([
  "activity",
  "support",
  "contribution",
  "control",
  "skill",
  "firepower"
]);

/*
功能
计算六轴雷达 polygon 的固定标准圈坐标。

调用方
createRadarChartMarkup 与 geometry 测试。

输入
六维 ratio、固定半径与中心坐标。

输出
冻结的六个 { key, ratio, x, y } 点。

读取状态
无。

写入状态
无。

调用函数
Math.cos、Math.sin。

边界与不变量
顶部固定为行动并按支援、贡献、控制、技能、火力顺时针排列；只保护零下限，ratio 大于一时必须越过标准圈。
*/
export function calculateRadarPoints(ratios, radius = 92, center = 160) {
  return Object.freeze(MATCH_PERFORMANCE_RADAR_AXIS_ORDER.map((key, index) => {
    const ratio = Math.max(0, Number(ratios[key]) || 0);
    const angle = -Math.PI / 2 + index * Math.PI / 3;
    return Object.freeze({
      key,
      ratio,
      x: center + Math.cos(angle) * radius * ratio,
      y: center + Math.sin(angle) * radius * ratio
    });
  }));
}

/*
功能
把雷达点转换为 SVG polygon points 属性。

调用方
createRadarChartMarkup。

输入
含 x/y 的点数组。

输出
以空格分隔的坐标字符串。

读取状态
无。

写入状态
无。

调用函数
Number.toFixed。

边界与不变量
不改变点的几何比例或顺序。
*/
function polygonPoints(points) {
  return points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
}

/*
功能
生成固定 100% 标准圈且允许表现 polygon 越界的六轴 SVG。

调用方
MatchMvpResultView.renderSelection。

输入
六维 radar ratios。

输出
可直接插入结果 View 的 SVG markup。

读取状态
无。

写入状态
无。

调用函数
calculateRadarPoints、polygonPoints。

边界与不变量
viewBox 与标准圈不随最大值缩放；SVG overflow visible，超过一的点保持真实位置；标签最后绘制以保持可读。
*/
export function createRadarChartMarkup(ratios) {
  const center = 160;
  const radius = 92;
  const standardPoints = calculateRadarPoints(
    Object.fromEntries(MATCH_PERFORMANCE_RADAR_AXIS_ORDER.map((key) => [key, 1])),
    radius,
    center
  );
  const rings = [0.25, 0.5, 0.75, 1].map((ratio) => {
    const points = standardPoints.map((point) => ({
      x: center + (point.x - center) * ratio,
      y: center + (point.y - center) * ratio
    }));
    return `<polygon class="match-mvp-radar-ring${ratio === 1 ? " is-standard" : ""}" points="${polygonPoints(points)}"></polygon>`;
  }).join("");
  const axes = standardPoints.map((point) => (
    `<line class="match-mvp-radar-axis" x1="${center}" y1="${center}" x2="${point.x.toFixed(2)}" y2="${point.y.toFixed(2)}"></line>`
  )).join("");
  const labels = standardPoints.map((point) => {
    const dx = point.x - center;
    const dy = point.y - center;
    return `<text class="match-mvp-radar-label" x="${(center + dx * 1.34).toFixed(2)}" y="${(center + dy * 1.34).toFixed(2)}">${MATCH_PERFORMANCE_LABELS[point.key]}</text>`;
  }).join("");
  const performancePoints = calculateRadarPoints(ratios, radius, center);
  return `<svg class="match-mvp-radar" viewBox="0 0 320 320" role="img" aria-label="六维表现雷达图，标准外圈为各维度上限">
    ${rings}${axes}
    <polygon class="match-mvp-radar-performance" points="${polygonPoints(performancePoints)}"></polygon>
    <circle class="match-mvp-radar-origin" cx="${center}" cy="${center}" r="3"></circle>
    ${labels}
  </svg>`;
}
