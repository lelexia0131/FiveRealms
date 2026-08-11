# FiveRealms AI 卡牌价值研究引擎（ai-card-study）

独立于 `tests/run.mjs` 正式回归测试的 AI 研究 / benchmark 工具集。它不改动游戏规则与 AI 业务逻辑，只通过成对（paired）干预实验测量“AI 在某个局面下对某张卡的价值判断与使用效果”。

引擎入口全部以 `D:/FiveRealms` 为工作目录运行。

## 这个引擎是做什么的

对同一固定局面（state）做两组对称的 AI self-play，仅在一侧施加与某张卡相关的干预，另一侧作为控制组，用两侧胜率之差（ΔWR = aWin − bWin，逐对记录）衡量该干预的价值。所有实验：

- 使用同一固定 seed 复现同一局面；
- 使用 deterministic RNG（`lib/rng.js` 的 `TrackedRng` + `lib/studyRandom.js` 的 `StudyRandom`/`installJobRandom`，同时固定 `Math.random` 与 `Date.now` 时钟）；
- 用 `structuralFingerprint` 校验局面一致（指纹不匹配的任务记为 `fingerprint-mismatch` 错误）；
- 停滞（stall）样本从统计中剔除；
- 结果写入运行目录的 `data/pairs-*.jsonl`，可断点续跑（`progress.json`）。

## 四类成对实验（metric）语义

来自 `lib/jobs.js` 的 `runStateJob`，每个 job 对某张卡、某个固定局面跑一对 arm：

- **Hold（持有）**：干预臂在控制局面基础上把该卡额外加入手中（`addExtraCardToHand`），控制臂不变。ΔWR = 持有该卡 − 不持有。
- **Acquire（获取）**：干预臂从牌堆把该卡取入手（`takeCardFromDeckToHand`），控制臂不变。ΔWR = 能获取该卡 − 不能。
- **Discard（弃牌）**：干预臂弃掉手中该卡（`discardCardFromHand`），控制臂保留。记录时 a=保留侧、b=弃牌侧，ΔWR = 保留 − 弃牌。
- **Use（使用）**：两侧都加卡入手，干预臂强制首动使用该卡（`installForcedFirstAction`），控制臂使用最佳其它行动（`installBestOtherFirstAction`）。ΔWR = 强制使用 − 最佳其它。

聚合（`lib/aggregate.js`）输出每张卡的 ΔWR、95% CI、按 HP/手牌/能量/局势/阶段分层的均值和按角色的价值矩阵；另有对“当前 `aiValue` 是否高估/低估”的提示，但这些只是研究建议，不修改任何 AI 逻辑。

## 目录约定（重要）

| 路径 | 内容 | 处理方式 |
|---|---|---|
| `tests/ai-card-study/` | 正式引擎代码（本目录） | **长期保存，纳入 Git，不得当临时文件删除** |
| `temp/ai-card-study-runs/<run-name>/` | 一次 run 的数据/输出（`data/`、`recovery/`、manifest、run-meta） | 可删除的运行中间数据 |
| `reports/` | 最终研究结论（报告/摘要） | 长期保存 |

运行目录通过 `FIVE_REALMS_STUDY_RUN_DIR=<路径>`（或 `study.js --run-dir <路径>`）指定，相对当前工作目录解析；**未指定时保持旧行为**（数据/输出写在引擎目录旁，仅用于向后兼容，不建议正式研究使用）。

引擎自身只读 `tests/ai-card-study/` 下的源码；一次 run 的所有写入都进入运行目录，不会污染 `tests/ai-card-study/`。

## 运行入口与常用命令

### 1. 生成语料（自对弈收集自然局面）

```powershell
node tests/ai-card-study/study.js corpus [games] [workers] [budget]
```

默认 240 局（`FIVE_REALMS_STUDY_CORPUS_GAMES`），生成 `data/corpus.json`、`data/corpus-states.jsonl`、`data/role-states.jsonl`。

### 2. 固定 manifest 并规划（plan）

manifest 是从自然局面里固定抽样的状态清单（`stateId = seed:turn`），保证正式研究使用固定样本且可复现：

```powershell
# 先用已生成的语料构建 manifest-2000.json / manifest-1000.json
node tests/ai-card-study/tools/build-manifest.mjs

# 规划校验：只读，不跑实验
node tests/ai-card-study/study.js --plan --manifest <manifest 路径>
# 或通过环境变量：$env:FIVE_REALMS_STUDY_MANIFEST = "<路径>"
```

`--plan` 会打印 planned states、Hold/Acquire job 数、以及 manifest 与语料的 missing/extra/duplicates 核对结果；指纹不匹配会直接报错。

### 3. 正式研究（建议用独立运行目录）

```powershell
$env:FIVE_REALMS_STUDY_RUN_DIR = "temp/ai-card-study-runs/run-2026-08-11"
$env:FIVE_REALMS_STUDY_MANIFEST = "temp/ai-card-study-runs/run-2026-08-11/manifest-1000.json"

node tests/ai-card-study/study.js experiment [workers] [budget]
node tests/ai-card-study/study.js windows [workers] [budget]   # 可选：响应窗口实验
node tests/ai-card-study/study.js aggregate
```

阶段（`study.js` 第一个位置参数）：`corpus`、`experiment`、`windows`、`aggregate`、`all`（按顺序全跑）。位置参数 `[workers] [budget]` 分别对应 worker 池大小与单臂节点预算；也可用 `--workers` / `--budget`。

### 4. 阶段性汇总与基准

```powershell
node tests/ai-card-study/interim.js          # 只读 data/，生成 interim-report.md / interim-master.csv / interim-role-matrix.csv
node tests/ai-card-study/bench.js [games] [workers]   # runPool/自对弈基准与克隆一致性验证
```

### 5. 补算与 run 元信息

```powershell
node tests/ai-card-study/tools/recovery.js        # 补算超时/缺失 job（内置 v117 缺失任务清单与 recovery/ 校验输出）
node tests/ai-card-study/tools/write-run-meta.mjs # 生成 run-meta.json（branch/HEAD/build/各文件 SHA-256）
```

`recovery.js` 是“针对某次具体 run 的补算工具”：它以 `data/progress.json` 为准找出未完成 job，用固定 seed 重跑，并把对照/校验结果写入运行目录的 `recovery/`。其内置的缺失任务清单来自 v117 run，仅对同类 run 直接可用。

## 按角色研究 AI 卡牌价值/使用

- `FIVE_REALMS_STUDY_ROLE_STATES`（默认 120）控制每个角色的角色态数量；角色态在语料阶段生成（`data/role-states.jsonl`）。
- `lib/aggregate.js` 对每个角色统计 `holdByRoleCard`，输出 `card-role-matrix.csv`（每卡×每角色的 ΔWR）与报告中“角色价值”章节。
- 需要时可用 `FIVE_REALMS_STUDY_USE_STATES`（默认 250）控制 Use 实验规模；`FIVE_REALMS_STUDY_ROLE_GAMES_PER_ROLE`（默认 40）控制角色语料局数。

## seed / deterministic RNG 的作用

每个 corpus 状态带 `seed`；manifest 用固定 `seed:turn` 标识状态。实验重放局面时使用该 seed 构造 `TrackedRng`，并在 worker 内通过 `installJobRandom` 让 `Math.random` 与时钟也确定性化，因此同一 manifest 在同一代码版本下可逐对复现。不要改动 `lib/rng.js`、`lib/studyRandom.js`、`structuralFingerprint` 的语义，否则历史结果不可比。

## manifest 的作用

manifest 把“从语料里随机抽哪些状态、按什么顺序”固化成文件（`tools/build-manifest.mjs`，固定 RNG seed `0xbeef1177`，要求语料含 3622 个自然状态——该数值来自 v117 语料，换语料时需按实际数量调整工具）。正式实验只跑 manifest 中的状态；`--plan` 可先核对 manifest 与语料的一致性。

## workers 参数

`study.js`/`bench.js` 的第二个位置参数（或 `--workers`）控制并行 worker 数，默认 24。`FIVE_REALMS_STUDY_JOB_TIMEOUT_MS`（默认 180000）控制单个 job 超时，超时 job 保留在 pending 供 recovery 补算，不会直接丢弃。

## 可删除的运行产物 vs 正式引擎

可删除（都在运行目录内，不在 `tests/ai-card-study/`）：

- `data/corpus*.json*`、`data/role-states.jsonl`
- `data/pairs-*.jsonl`、`data/progress.json`、`data/experiment-errors.json`、`data/job-runtime.jsonl`
- `recovery/` 下的校验输出、`logs/`
- `manifest-*.json`、`run-meta.json`（可重新生成）

正式引擎（**不得当临时文件删除**）：`tests/ai-card-study/` 下全部 `*.js` / `*.mjs`、`lib/`、`tools/`、本 `README.md`。`temp/` 里只放 run 数据；最终结论沉淀到 `reports/`。

## 与正式测试的关系

本目录是独立研究工具，不加入 `tests/run.mjs`；`tests/run.mjs` 继续作为快速回归测试。研究类长 benchmark 不进入常规单元测试。
