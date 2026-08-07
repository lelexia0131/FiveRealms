# FiveRealms 测试说明

本文档说明 FiveRealms（五域纷争）的自动测试和 AI 平衡测试方法。

测试分为两类：

1. **功能测试**：检查规则、卡牌、技能、AI、浏览器模块版本等代码行为是否正确。
2. **Balance 平衡测试**：让 5 个 AI 多局自博弈，统计阵营、角色、卡牌、技能、战斗流程和性能数据。

除非明确需要调试，建议不要让 Balance 测试把完整 JSON 输出到终端。正式结果应写入 `reports` 目录，只在终端保留进度和最终摘要。

---

## 1. 运行环境

在项目根目录执行命令：

```powershell
cd D:\FiveRealms
```

确认 Node.js 和 npm 可用：

```powershell
node --version
npm --version
```

Balance 测试脚本位置：

```text
tests/balance.mjs
```

`package.json` 中应包含：

```json
{
  "scripts": {
    "test:balance": "node ./tests/balance.mjs"
  }
}
```

---

## 2. 功能测试

运行完整功能测试：

```powershell
npm test
```

功能测试用于检查：

- 核心规则和状态变化；
- 卡牌及技能结算；
- AI 合法性、评分和模拟；
- 阵亡、濒死、救援与清理；
- 浏览器模块统一 `?build=` 标识；
- 其他已有回归测试。

修改业务代码后，应先运行与改动直接相关的定点测试，再运行完整测试。

测试失败时，不应仅删除或放宽断言。必须先确认：

1. 代码行为是否违反正式规则；
2. 测试是否仍描述当前正式规则；
3. 失败是否来自本次改动；
4. 是否存在缓存、模块版本或加载链不一致。

---

## 3. Balance 测试概述

运行入口：

```powershell
npm run test:balance -- [参数]
```

Balance 测试使用 Node.js Worker Threads 并行运行多个独立 AI 对局。每一局根据全局局号和基础种子产生可复现的随机序列。

测试会统计尽可能多的对局信息，包括：

- 小队和大队胜率；
- 黎明、暮影阵营胜率；
- 平均轮数、轮数中位数、P95 和最大轮数；
- 回合数、重洗次数；
- 总伤害、承受伤害、治疗量；
- 突袭次数、死亡数、濒死和救援；
- 卡牌使用次数、成功结算和取消次数；
- 不同卡牌、卡牌类别和移动原因；
- 装备使用情况；
- 主动技能使用情况；
- 各角色胜率、生存率和平均战斗数据；
- 各座位胜率和先手影响；
- 单局耗时分布和总体吞吐量；
- 停滞局、异常局和最慢对局样本。

---

## 4. 推荐的日常 Balance 测试

推荐使用 24 个 Worker，并准备 24 个备用候选局：

```powershell
npm run test:balance -- `
  --games 200 `
  --reserve-games 24 `
  --workers 24 `
  --progress `
  --progress-every 10 `
  --no-stdout `
  --summary `
  --game-timeout-ms 120000 `
  --retries 0 `
  --output reports\balance-200.json
```

该命令的含义：

```text
目标统计结果：200 局
候选局总数：224 局
并行 Worker：24
AI 每次搜索：1000 节点（默认值）
单局最大轮数：250（默认值）
单局墙钟超时：120 秒
异常局重试：0 次
终端：显示每 10 局进度和最终摘要
完整结果：写入 reports\balance-200.json
```

正常启动信息应类似：

```text
[balance] 目标 200 局，准备 224 个不同候选局，24/24 个 Worker，
每次搜索 1000 节点，最大 250 轮。
```

测试收集到第 200 个有效结果后会立即停止，尚未完成的候选局会被终止，不再等待最后几局特别慢的对局。

---

## 5. 为什么使用“224 选前 200”

如果只准备 200 个候选局，那么完成到 `195/200` 后只剩 5 个唯一对局：

```text
195/200：最多只有 5 个 Worker 有有效工作
196/200：最多只有 4 个 Worker 有有效工作
```

某些随机种子可能产生明显更长的对局，因此最后几局会形成长尾，看起来像测试卡住。

旧的尾部投机方案会让空闲 Worker 重复执行相同种子。由于相同种子的角色、发牌和 AI 决策路径基本一致，重复副本通常仍然同样慢，只会让 CPU 保持满载，不能可靠消除长尾。

当前推荐方案会准备额外的不同候选局：

```text
200 个目标结果 + 24 个备用候选 = 224 个不同候选局
```

只要任意 200 局先完成，就立即生成报告并终止其余任务。这样不会固定等待最慢的几个种子。

---

## 6. 备用候选模式的统计影响

`--reserve-games 24` 使用的是“先完成的 200 个有效结果”，并非固定采用局号连续的前 200 局。

优点：

- 显著减少最后几局造成的等待；
- Worker 在大部分运行时间内保持充分利用；
- 日常平衡迭代更快；
- 不会因少数极慢局拖延整个测试。

限制：

- 最慢候选局更可能被放弃；
- 平均轮数和单局耗时可能略微偏低；
- 如果某些角色组合天然更慢，它们可能被轻微低估；
- 不适合要求完全固定样本集合的严格对比实验。

因此：

- **日常平衡验证**：使用 `--reserve-games 24`。
- **严格可复现对照测试**：使用 `--reserve-games 0`。

---

## 7. 严格可复现模式

需要固定统计连续的 200 个局号时运行：

```powershell
npm run test:balance -- `
  --games 200 `
  --reserve-games 0 `
  --workers 24 `
  --progress `
  --progress-every 10 `
  --no-stdout `
  --summary `
  --game-timeout-ms 120000 `
  --retries 0 `
  --output reports\balance-200-strict.json
```

该模式会等待全部指定局号结束，因此最后几局可能较慢。

建议在以下情况使用：

- 比较同一批固定种子修改前后的结果；
- 定位特定局号的问题；
- 调查长局、停滞局或异常种子；
- 需要严格复现实验结果；
- 准备正式平衡结论。

---

## 8. 快速测试

只观察大致趋势：

```powershell
npm run test:balance -- `
  --games 50 `
  --reserve-games 12 `
  --workers 24 `
  --progress `
  --progress-every 10 `
  --no-stdout `
  --summary `
  --game-timeout-ms 120000
```

快速测试样本较少，角色胜率容易受到随机波动影响，不应用于最终平衡结论。

---

## 9. 大样本测试

修改角色、技能、卡牌数量或 AI 权重后，可以运行 1000 局：

```powershell
npm run test:balance -- `
  --games 1000 `
  --reserve-games 48 `
  --workers 24 `
  --progress `
  --progress-every 50 `
  --no-stdout `
  --summary `
  --game-timeout-ms 120000 `
  --retries 0 `
  --output reports\balance-1000.json
```

大样本测试仍应结合多组不同 `--start-index` 或 `--seed-base` 检查，避免结论过度依赖单一随机样本。

---

## 10. 只保留最终统计结果

不显示中间进度，也不把完整 JSON 打印到终端：

```powershell
npm run test:balance -- `
  --games 200 `
  --reserve-games 24 `
  --workers 24 `
  --no-progress `
  --no-stdout `
  --summary `
  --game-timeout-ms 120000 `
  --retries 0 `
  --output reports\balance-200.json
```

运行期间终端基本不会更新，CPU 满载时通常表示 Worker 仍在计算，不代表程序已经卡死。

为了避免视觉上的“假死”，日常使用更建议保留：

```text
--progress --progress-every 10
```

---

## 11. 输出控制

### 显示进度

```text
--progress
```

关闭：

```text
--no-progress
```

### 每多少局输出一次进度

```text
--progress-every 10
```

### 显示最终中文摘要

```text
--summary
```

关闭：

```text
--no-summary
```

### 在终端输出完整 JSON

```text
--stdout
```

关闭：

```text
--no-stdout
```

正式运行建议使用：

```text
--no-stdout --summary
```

### 把完整报告写入文件

```text
--output reports\balance-200.json
```

`--no-stdout` 不会影响 `--output`，因此可以让终端保持整洁，同时保留完整报告。

---

## 12. 常用参数

| 参数 | 含义 | 推荐值 |
|---|---|---:|
| `--games <n>` | 最终需要纳入统计的有效局数 | `200` |
| `--reserve-games <n>` | 额外准备的不同候选局数 | `24` |
| `--workers <n\|auto>` | Worker 数量 | `24` |
| `--reserve-cores <n>` | `auto` 模式预留的逻辑核心 | 按机器情况 |
| `--search-node-budget <n>` | 每次 AI 规划节点预算 | `1000` |
| `--start-index <n>` | 候选局起始全局局号 | `0` 或不同区间 |
| `--seed-base <n>` | 基础随机种子 | 保持固定或明确记录 |
| `--max-rounds <n>` | 单局最大轮数 | `250` |
| `--game-timeout-ms <n>` | 单局墙钟超时；`0` 为关闭 | `120000` |
| `--retries <n>` | 单局异常后的重试次数 | `0` |
| `--progress-every <n>` | 进度输出间隔 | `10` |
| `--output <path>` | JSON 报告路径 | `reports\balance-200.json` |
| `--report-only` | 跳过胜率区间失败判定 | 调试统计时使用 |
| `--include-game-records` | 在 JSON 中加入逐局记录 | 定位问题时使用 |

查看脚本支持的全部参数：

```powershell
npm run test:balance -- --help
```

---

## 13. 报告摘要解释

最终摘要示例：

```text
[balance] ===== 测试摘要 =====
[balance] 对局：200/200 完成，停滞 0，失败 0
[balance] 胜率：小队 44%（88 胜），大队 56%（112 胜）
[balance] 轮数：平均 4.59，中位 4，P95 9，最大 31
[balance] 战斗：平均突袭 14.63，救援率 26.6%，死亡 577
[balance] 卡牌：共使用 10551，结算成功 10313，取消 238
[balance] 性能：56.983 秒，3.51 局/秒
[balance] 候选：准备 224 局，纳入 200 局，放弃 24 局
[balance] 并行：峰值 24 Worker，投机任务 0，投机获胜 0
```

说明：

- `200/200 完成`：目标样本已经收集完毕。
- `停滞 0`：没有对局达到最大轮数仍无法决出胜负。
- `失败 0`：没有候选局因 Worker、异常或超时被计为永久失败。
- `准备 224，纳入 200，放弃 24`：备用候选模式正常生效。
- `投机任务 0`：没有重复运行相同局号。
- `小队胜率`：2 人队获胜比例。
- `大队胜率`：3 人队获胜比例。
- `P95 轮数`：95% 的已纳入对局不超过该轮数。
- `结算成功/取消`：卡牌使用后是否实际完成效果结算。

单次 200 局结果只能用于发现明显趋势。角色个体胜率的出现次数可能远低于 200，不能只看一个百分比判断角色强弱。

---

## 14. 如何判断测试是否真的卡住

### 正常计算

符合以下特征时通常仍在正常运行：

- CPU 使用率较高；
- 进度偶尔增加；
- Worker 数仍大于 0；
- 尚未达到单局超时时间；
- 日志显示仍有候选局运行。

### 可能异常

以下情况需要调查：

- 同一进度超过 `--game-timeout-ms` 仍不变化；
- CPU 接近空闲，但进程不退出；
- 重复出现同一个 Worker 异常；
- 报告中 `failedGames` 大于 0；
- 报告中出现停滞局或死亡清理违规；
- 固定局号每次都出现异常或极端耗时。

需要停止运行时按：

```text
Ctrl+C
```

不要直接关闭整个终端或强制重启电脑。

---

## 15. 单局超时和失败处理

推荐设置：

```text
--game-timeout-ms 120000
```

表示某个候选局运行超过 120 秒后终止对应 Worker。

日常 Balance 测试推荐：

```text
--retries 0
```

理由是备用候选可以补足目标样本，不需要反复等待异常候选局。

严格固定样本测试可以使用：

```text
--retries 1
```

但必须检查重试原因，不能把持续超时简单视为随机波动。

---

## 16. Node.js 模块类型警告

运行时可能重复显示：

```text
[MODULE_TYPELESS_PACKAGE_JSON] Warning:
Module type of .../js/core/Game.js is not specified...
```

每个 Worker 都会独立加载 `Game.js`，所以警告可能重复多次。

该消息是 Node.js 对 ES Module 识别方式的性能警告，不代表对局失败。只要后续进度正常增加，可以继续测试。

不要仅为了消除警告，未经完整验证就直接给项目 `package.json` 添加：

```json
"type": "module"
```

这可能改变其他脚本的模块解析方式。应把模块类型调整作为独立任务处理，并运行完整测试验证。

---

## 17. 平衡结论的使用原则

Balance 报告提供的是统计证据，不等于直接证明某个规则或 AI 逻辑正确。

分析结果时至少检查：

1. 样本量是否足够；
2. 角色出现次数是否均衡；
3. 角色在小队和大队中的胜率是否分别合理；
4. 先手、座位和阵营身份是否形成偏差；
5. 胜率变化是否伴随伤害、治疗、存活率或技能频率变化；
6. 是否存在少量极端局拉高平均值；
7. 不同种子区间是否得到相似趋势；
8. 修改前后是否使用了相同测试模式和参数。

不要因为单次测试中某角色胜率较高，就立即削弱角色。应结合规则设计、代码证据、更多样本和浏览器实际对局判断。

---

## 18. 修改后的推荐测试流程

涉及规则、技能、AI 或平衡数值的修改，推荐按以下顺序执行：

1. 运行与改动直接相关的定点测试；
2. 运行完整功能测试：

   ```powershell
   npm test
   ```

3. 运行 50～200 局快速 Balance 测试；
4. 检查失败、停滞和异常样本；
5. 运行大样本 Balance 测试；
6. 对比修改前后的同类报告；
7. 进行浏览器人工验证；
8. 用户确认后手动提交 Git。

自动测试通过不能代替浏览器人工验证。特别是 HTML、CSS、JS 或 ES Module 修改后，还必须确认浏览器实际加载了统一的新 `?build=` 资源图。

---

## 19. 当前推荐命令汇总

### 日常推荐

```powershell
npm run test:balance -- `
  --games 200 `
  --reserve-games 24 `
  --workers 24 `
  --progress `
  --progress-every 10 `
  --no-stdout `
  --summary `
  --game-timeout-ms 120000 `
  --retries 0 `
  --output reports\balance-200.json
```

### 严格固定样本

```powershell
npm run test:balance -- `
  --games 200 `
  --reserve-games 0 `
  --workers 24 `
  --progress `
  --progress-every 10 `
  --no-stdout `
  --summary `
  --game-timeout-ms 120000 `
  --retries 1 `
  --output reports\balance-200-strict.json
```

### 快速趋势测试

```powershell
npm run test:balance -- `
  --games 50 `
  --reserve-games 12 `
  --workers 24 `
  --progress `
  --progress-every 10 `
  --no-stdout `
  --summary
```

### 仅保存报告

```powershell
npm run test:balance -- `
  --games 200 `
  --reserve-games 24 `
  --workers 24 `
  --no-progress `
  --no-summary `
  --no-stdout `
  --game-timeout-ms 120000 `
  --retries 0 `
  --output reports\balance-200.json
```
