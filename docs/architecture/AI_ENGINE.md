# FiveRealms AI Engine 2.0

状态：AI-ARCH-1 只读审计基线
基线提交：`e16a429 fix: preserve end fallback against non-positive actions`
审计日期：2026-08-14
范围：`js/ai/**/*.js`、直接上游、规则权威源和相关测试；本文件不宣称已完成任何生产迁移。

## 1. 文档职责

本文件是 AI 架构的长期事实来源，记录：

- 当前实现和真实运行依赖；
- 状态、隐藏信息、规则镜像与价值 owner；
- 已确认的耦合、重复计分和性能风险；
- 目标边界与 AI-ARCH-2 至 AI-ARCH-10 的迁移顺序；
- 每个阶段的行为冻结、验证和回滚契约。

代码风格与函数头只在 `CODE_STANDARD.md` 定义。本次审计是代码与测试证据，不是对未来实现的推测；目标架构是迁移约束，不表示对应目录或 API 已存在。

## 2. 基线与验证边界

- 工作分支：`deepseek-fixes`。
- 起始工作区：干净。
- AI 浏览器构建标识：`20260814-spirit-medic-heal-economics`。
- 当前生产 AI 文件：19 个，共约 8,300 行；其中 `AiSimulator.js` 约 3,800 行，是首要风险集中点。
- 上游生产入口：`Game` 创建一个 `AIController`；`Game`、`ResponseSystem`、`PublicCardPool`、`skillRegistry` 通过控制器或其公开子组件请求决策。
- 测试入口：`tests/run.mjs` 的 `AI 系统` 及真实规则区域、`tests/ai-benchmark`、`tests/ai-card-study`。
- 本阶段只读审计生产 AI；没有改规则、权重、搜索策略、模拟结果或浏览器模块图。

## 3. 当前模块清单与归属结论

处置标签含义：KEEP 原位稳定；MOVE 移到新层；SPLIT 拆分职责；MERGE 合并同一 owner；RENAME 明确语义；DEPRECATE 迁移后删除旧入口。

| 当前文件 | 当前角色、主要导出/函数 | 上游 / 下游 | 状态与信息边界 | 问题与目标 | 处置 |
|---|---|---|---|---|---|
| `AiController.js` | 组装门面；`getLegalActions`、`selectAction`、描述重绑与选择转发 | `Game` / Visible、Knowledge、Policy、Generator、Evaluator、Planner | 读 GameState，经可见投影进入 AI；自身不结算 | 构造依赖合理，但公开暴露子组件，成为服务定位器 | KEEP + 收窄 API |
| `AiVisibleState.js` | `createAiVisibleState` 同时做观察投影、Belief 初始化和 SearchState 填充 | Controller、ResponsePolicy、测试 / TeamRule、skill cost、CardValue | 读完整 GameState；只输出自己手牌、他人已知牌与计数 | 三种状态职责混合，外层冻结不等于独立 SearchState | SPLIT → state |
| `AiKnowledge.js` | 合法私有记忆、剩余牌计数、隐藏世界采样 | Controller、Planner / card config、Game 随机源 | 读 viewer 记忆和公开区；不读敌方未知牌面 | `sampleHiddenWorlds` 属 Belief，Planner 通过控制器回取 | SPLIT → Knowledge + BeliefState |
| `AiActionGenerator.js` | 根/深层动作枚举、次数槽、概率可用性、转移方案 | Controller、Planner / RuleEngine、domain、policy/value、Probability | 根节点读 GameState；深层读 SearchState | 合法枚举混入 3v1 禁雷、零收益过滤、转移策略；回指 CardSelector | SPLIT → search/ActionGenerator + policy/domain |
| `AiPlanner.js` | 有限深度 beam、候选账本、响应反事实、破势/封印边际 | Controller / Simulator、Evaluator、seal；运行时回指 Generator、Knowledge | 只应读 SearchState/Belief，当前持有 Game 引用 | 搜索算法混入牌域规则和价值合成；依赖服务定位器 | SPLIT → Planner + SearchPolicy + TransitionValue |
| `AiSimulator.js` | 克隆、动作分派、卡牌/技能/状态/响应/伤害/濒死全镜像 | Planner、Evaluator、ResponsePolicy、测试 / RuleEngine、skill、domain、policy/value | 写克隆后的 SearchState；不写 GameState | God Object；规则镜像面积大，规则漂移和重复消费风险最高 | SPLIT → simulation 子域 |
| `AiEvaluator.js` | 玩家/局面价值、owner ledger、机会成本、先验、经济、前沿残值、雷电生命周期 | Planner、ResponsePolicy、测试 / Simulator、domain、CardValue、Threat | 读 SearchState；不应结算 | Value 同时驱动模拟；Lightning 价值内建模拟；多个账本语义相邻 | SPLIT → value + domain |
| `AiResponsePolicy.js` | 格挡/反制/护援/濒死/状态响应 | ResponseSystem、Controller / Visible、Simulator、Evaluator、domain | 根响应读 GameState 后构造可见状态；不应改 GameState | Policy 自建模拟和状态投影，域公式混入 | SPLIT → policy/ResponsePolicy |
| `AiCardSelector.js` | 隐藏牌、区域、转移、公共牌、弃牌选择 | Controller、Game、PublicCardPool、skill / RuleEngine、policy/value | 执行边界可持真实实体；敌方未知定义仅按记忆/位置 | 多种资源策略聚合，合法实体解析与价值策略混合 | SPLIT → policy 子策略 |
| `AiProbabilityBranches.js` | 概率归一、合并、连接、投影和条件分区；另含雷达判定 | 多个 AI 模块 / card config | 纯分支值；无状态写入 | 通用概率层被雷达牌域污染 | SPLIT → state/Probability + domain/Radar |
| `AiEconomics.js` | `HP_VALUE`、`STATE_DELTA_SCALE` | Evaluator、Planner、Policy、Simulator | 常量 | Planner 从 Evaluator 重导入，owner 不清晰 | MOVE → value/Economics |
| `ThreatCalculator.js` | `calculate` 公共威胁值 | Evaluator、transfer / 无 | 只接受公开/过滤字段 | 职责清晰 | MOVE → value/ThreatValue |
| `roleCardValue.js` | 基础牌值、角色差量、装备保留差量及校验 | Generator、Selector、Evaluator、Simulator、policy/value | 配置派生，无隐藏信息 | 同时服务 prior、选择和模拟，需固定“静态 CardValue”语义 | MOVE → value/CardValue |
| `discardScoring.js` | 弃牌保留值、排序、选择 | Selector、Simulator / CardValue | 对自己/实际支付者的手牌操作 | Policy 与静态价值轻度混合 | MOVE → policy/ResourceSelectionPolicy |
| `resourceSelectionValue.js` | 资源用途效用与手牌/区域选择 | Selector、Simulator / CardValue、transfer | 已知实体或未知期望；不窥牌 | 文件名为 value，实际 owner 是选择策略 | MOVE + RENAME → policy/ResourceSelectionPolicy |
| `transferScoring.js` | 转移候选、组合评分、未知手牌期望、威胁视图 | Generator、Selector、resource / CardValue、Threat、Probability | 可见/合法记忆；未知牌用期望 | TransferPolicy、CardValue、ThreatValue、手牌上限域混合 | SPLIT → policy/TransferPolicy + value |
| `lightningScoring.js` | 雷电状态分支、判定概率、传递链、命中分布 | Generator、Evaluator、Policy、Simulator / RuleEngine、Probability | 读 SearchState/remaining counts | 已是域模型而非单纯 scoring，且部分规则镜像 | MOVE + RENAME → domain/LightningModel |
| `sealScoring.js` | 封印状态/反制/判定/时序/威胁/延迟价值 | Generator、Planner、Policy、Simulator、Evaluator / RuleEngine、Distance | 读 SearchState/remaining counts | Domain、ThreatValue、Search timing 混合 | SPLIT → domain/SealModel + value/search |
| `AiGlobalBenefit.js` | 互利/共生/全局牌收益、反制欲望、root flip 反事实 | Evaluator、Policy、Simulator / CardValue；模拟器由调用方注入 | 读 SearchState，函数式返回 | Domain、Policy、Economics 与模拟辅助混合；注入仅避免静态环 | SPLIT → domain/GlobalBenefitModel + policy |

### 当前测试与回归映射

| 责任域 | 当前证据入口 | 已覆盖重点 | ARCH-2 以后需补的契约 |
|---|---|---|---|
| Visible/Knowledge/Belief | `tests/run.mjs` 的 `AI·可见状态`、`AI·窥探`、未知牌互换场景 | 不含敌方真实手牌、remaining counts 只读、card ID 记忆失效 | Visible/Belief/Search 三对象 schema 与转换边界 |
| ActionGenerator | `AI·动作生成` 及每张牌/技能的根与深层生成测试 | 动态距离、目标阵营、次数槽、概率装备合法性 | `generateLegal` 与策略过滤分离后集合包含关系 |
| Planner/Value | 大量 `AI·搜索`、transition delta、ledger、frontier、end fallback 测试 | 固定节点、深度、state delta、响应互斥、frontier once、诊断等价 | 旧/新 trace 逐 term 对照与稳定 tie-break |
| Simulator | `AI·模拟器` 及突袭、借势、决斗、雷达、角色技能等场景 | clone 隔离、概率分支、伤害/响应/濒死、实体消费 | 与真实 Game/Response/Dying/Card/Skill authority 的表驱动差分 |
| Response/Selection Policy | 借势响应、护援、封印/闪电反制、窥探/转移/弃牌测试 | 不泄露、资源保留、状态响应和选择一致 | DecisionContext 不含 Game/Simulator concrete 的构造测试 |
| Domain models | `AI·封印`、`AI·闪电`、`AI·互利`、雷达判定测试 | remaining-count 概率、未来 RNG 隔离、座次和阵营投影 | Domain 输出 schema、概率质量和无反向依赖测试 |
| 端到端与性能 | `tests/ai-benchmark`、`tests/ai-card-study`、Balance harness | 生产 Controller、固定节点/seed、场景报告 | clone/apply/stateUtility/branch 计数基线与阶段对比 |

测试量很大，但当前更偏行为回归；“真实权威与模拟镜像对同一输入产生等价 Transition”的系统化差分层仍缺失。这是 ARCH-7/8 的前置验收项，不应在 ARCH-2 先行扩大。

## 4. 当前静态 import 图

以下省略 config/core 的叶子依赖，但保留 AI 内部方向：

```text
Game -> AIController
AIController -> VisibleState, Knowledge, CardSelector, ResponsePolicy,
                ActionGenerator, Evaluator, Planner

Planner -> Simulator, Evaluator, SealModel
Evaluator -> Simulator, Probability, Threat, GlobalBenefit,
             CardValue, LightningModel, SealModel, Economics
ResponsePolicy -> VisibleState, Simulator, Evaluator(injected), Knowledge(injected),
                  GlobalBenefit, LightningModel, SealModel, Economics
ActionGenerator -> RuleEngine, Probability, LightningModel, SealModel,
                   TransferScoring, skillRegistry, Distance
Simulator -> RuleEngine, Probability, LightningModel, SealModel,
             GlobalBenefit, Economics, resource/discard/CardValue, skillRegistry
CardSelector -> RuleEngine, TransferScoring, CardValue,
                discard/resource selection
VisibleState -> TeamRuleService, skillRegistry, CardValue
TransferScoring -> CardValue, Threat, Probability
ResourceSelection -> CardValue, TransferScoring
LightningModel -> RuleEngine, Probability
SealModel -> RuleEngine, Distance, Probability
GlobalBenefit -> CardValue
```

结论：当前 ES module 静态图未发现已闭合的 import cycle。`AiGlobalBenefit` 通过注入 simulator 避免了 `Simulator -> GlobalBenefit -> Simulator` 静态闭环，但该做法没有消除职责反向依赖。

## 5. 当前运行时依赖与回指

真实运行时存在服务定位器式环：

```text
Game -> AIController -> Planner
  ^          |            |
  |          |            +--> game.aiController.actionGenerator
  |          |            +--> game.aiController.knowledge
  |          |
  |          +--> ActionGenerator
  |                         +--> game.aiController.cardSelector
  |
  +-- ResponseSystem/PublicCardPool/skillRegistry -> game.aiController.*
```

已确认位置：

- Planner 深层展开两次回取 `actionGenerator.generateFromVisible`；根计划回取 `knowledge.sampleHiddenWorlds`。
- Planner 的破势边际计算再次回取 ActionGenerator。
- ActionGenerator 根转移选择回取 `cardSelector.chooseTransferCombination`。
- `Game`、`ResponseSystem`、`PublicCardPool` 和 `skillRegistry` 直接访问控制器子组件。

这不是语法层 import cycle，却形成 Controller → Planner/Generator → Controller 的运行时依赖环，导致组件无法独立构造、测试和替换。

## 6. 依赖矩阵

`R` 为直接静态依赖，`I` 为构造注入，`B` 为 `game.aiController` 回指，`—` 为无直接依赖。

| 调用方 | State/Knowledge | Search | Simulation | Value | Policy | Domain | Core rules | Controller |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Controller | R | R | — | R | R | — | — | — |
| VisibleState/Knowledge | — | — | — | R | — | — | R | — |
| ActionGenerator | — | — | — | R | R/B | R | R | B |
| Planner | B | — | R | R/I | — | R | — | B |
| Simulator | — | — | — | R | R | R | R | — |
| Evaluator | — | — | R | — | — | R | R | — |
| ResponsePolicy | R/I | — | R | I/R | — | R | — | — |
| CardSelector | I | — | — | R | R | — | R | — |
| Domain models | — | — | I（GlobalBenefit） | R | — | — | R | — |

目标是单向：Controller 组装；Search 依赖显式的 State、ActionGenerator、Simulator、Value 接口；Simulation 依赖 Rule Projection 与无副作用 domain helpers；Value 只能读取 State/Domain 派生值，不能启动 Simulation；Policy 可请求受限的 Simulation query，但不能构造整套 Controller。

## 7. 规则权威、模拟镜像与派生模型

定义：

- **AUTHORITY**：真实对局最终合法性和结算的唯一权威。
- **SIMULATION MIRROR**：只作用于 SearchState 的预测实现，必须通过契约测试与权威对齐。
- **DERIVED MODEL**：基于合法可见信息的概率或效用近似，不承诺逐事件等价。

| 规则域 | AUTHORITY | 当前 SIMULATION MIRROR | DERIVED MODEL / 风险 |
|---|---|---|---|
| 伤害、护盾、before/afterDamage | `Game.damage` + EventBus 被动技能 | `AiSimulator.applyDamage`、`simulateAfterLifeDamage` | 暴露度、风险和 HP 价值；镜像需覆盖事件顺序 |
| 格挡/雷达防御判定 | `Game.damage`、`ResponseSystem.askForBlock`、`JudgmentSystem.judgeDefense` | `consumeBlockResponseWorlds`、`buildRadarOutcomePartition` | block 分布、radar 判定概率；不可当权威 |
| 战术反制链 | `ResponseSystem.askForCounter/askForStatusCounter` | scope/target counter response 与 counter distribution | `counterDesire`、dynamic flip gain；奇偶深度和资源消费易漂移 |
| 阵亡与濒死救援 | `DyingSystem.enter/resolve/kill`、`requestDyingRescue` | `resolveFatal` 及预计调息消费/击杀奖 | 存活概率和死亡价值；不得产生半血存活等非法中间态 |
| 护援 | `skillRegistry.guardianAid` 的 `beforeDamage` 监听 | `simulateGuardianAid` | 护援响应价值/弃牌成本；顺序、次数旗标需对齐 |
| 主动技能费用/次数 | `getActiveSkillCost`、`ACTIVE_SKILLS.canUse/execute`、`Game.useActiveSkill` | `syncActiveSkillCosts`、`applySkill`、skill slots | 未来 readiness/threat；镜像不可自行发明费用 |
| 目标合法性 | `RuleEngine.getCardTargets/targetLegality/getSkillTargets` | ActionGenerator 与 Simulator 的深层过滤 | 策略过滤不是合法性；零收益不能删掉必须保留的合法入口 |
| 卡牌可用性 | `RuleEngine.canPlayCard`、`Game.playCard`、`cardRegistry` | ActionGenerator、Simulator action dispatch | `cardAvailability` 概率；实体 ID 不得重复消费 |
| 延迟状态判定 | `Game` 回合判定流程 + `JudgmentSystem` | Lightning/Seal model + Simulator | remaining-count 概率、转移链；模型是预测而非权威 |
| 卡牌效果 | `cardRegistry` + Game 资源移动 API | `AiSimulator.apply` 大型分派 | 行动 prior/经济模型；镜像面积过大是主要维护风险 |

迁移原则：不尝试让 SearchState 调用异步 UI/事件总线权威；先把权威规则提炼为无副作用的共享判定/效果规格，再让真实执行和模拟分别适配。共享规格尚未存在前，镜像必须保留并由差分契约测试保护。

## 8. 状态 owner 与生命周期

| 状态 | 唯一 owner | 可写者 | 当前落点 | 约束 |
|---|---|---|---|---|
| GameState | `Game` 及 core systems | Game、Response/Dying/Judgment、card/skill authority | `game.state` | AI 决策层只读；Simulator 永不写入 |
| VisibleState | state/VisibleState 投影 | 创建函数一次性构造 | 当前 `createAiVisibleState` | 只含 LEGAL OBSERVATION 和 viewer 自身私有信息；完成后不可变 |
| Knowledge | viewer 的合法私有记忆 | Game 的记忆/失效 API | `aiMemory.knownCardsByPlayer` + `AiKnowledge` | 绑定 card ID 和 owner；离开原手牌立即失效 |
| BeliefState | state/BeliefState | Belief builder/sampler | 当前分散在 VisibleState、Knowledge、Probability | 只由 VisibleState+Knowledge+剩余牌推导；不得反查真实未知牌 |
| SearchState | simulation/state | Simulator 对独立克隆写入 | 当前 VisibleState 输出兼作 initial SearchState | 每个分支独立；实体/概率资源守恒；不得含 UI 或 Game 引用 |

当前主要问题：`createAiVisibleState` 同时构造 Visible、Belief 和 Search 字段，导致字段来源和可写生命周期不清晰；Object.freeze 只冻结外层与玩家对象，不能作为状态层已经正确分离的证据。

## 9. 隐藏信息审计

| 路径 | 标签 | 结论 |
|---|---|---|
| 自己手牌、所有公开区、生命/能量/装备/状态/手牌数量 | LEGAL OBSERVATION | 可直接进入 VisibleState |
| `aiMemory.knownCardsByPlayer` 中仍属于原 owner 的 card ID/definition | MEMORY | 合法；卡移动后由 Game 失效 |
| `remainingCounts`、expected card counts、block/counter/assault distributions、sampled worlds | BELIEF | 合法；只由观察+记忆推导，输入必须只读 |
| 选择系统执行时持有敌方真实 card 实体但不读取未知 definition | LEGAL OBSERVATION（opaque execution token） | 可用于位置/ID提交，策略不得按未知牌面排序 |
| Planner/Evaluator/Policy 读取敌方实际未知 `definitionId` | ILLEGAL | 本次 AI 主链未发现；未来 Guard/测试必须继续阻止 |
| 使用未来真实 RNG 结果评估互利、判定或抽牌 | ILLEGAL | 当前模型使用 remaining counts/期望；测试已有约束 |

风险边界：`AiCardSelector` 处于真实执行边界，能看见实体对象。其隐藏牌路径必须持续用 memory map 与 unknown position 选择，不能让通用 `expectedCardValue` 意外接触未知定义。

## 10. 价值 owner 与防重复计分

| 概念 | 当前 owner | 当前用途 | 目标 owner | 审计结论 |
|---|---|---|---|---|
| `actionUtility` / `actionSearchPrior` | Evaluator | 根/节点排序先验 | SearchPolicy + CardValue | 只能排序/裁剪，不能再作为最终收益相加 |
| `actionEconomicValue` | Evaluator | 即时经济项 | value/Economics | 仅记录未在 state delta 体现的流量；需逐项契约 |
| `stateUtility` | Evaluator | 单状态价值 | value/Evaluator | State Value 唯一 owner |
| `stateDelta` | Planner 计算 `after-before` | transition 主体 | value/TransitionValue | 只计算一次并明确缩放单位 |
| owner ledger | Evaluator | 诊断与响应反事实 | value/ValueLedger | 生产开关不得改变候选值和选择 |
| response ledger | Planner | 诊断/反事实拆分 | value/ValueLedger | 当前组合代数应互斥；迁移时先锁定等价测试 |
| `cardOpportunityCost` | Evaluator | 诊断 | value/CardValue/ValueLedger | 实际手牌损失已进入 state delta；不得二次扣除 |
| `frontierResidual` | Evaluator，Planner 终点合成 | 未展开未来存量 | search/FrontierValue | 只能在 frontier/terminal 计一次，不能每层累计 |
| seal delay/timing | sealScoring + Planner | 同层替代机会 | domain/SealModel + search/TransitionValue | 依赖 sibling，不能藏进通用 stateUtility |
| expose/assault marginal | Planner | 根技能反事实/旧层兑现 | domain + TransitionValue | 与 Simulator 已落地伤害互斥；只计额外层边际 |
| static card value | roleCardValue | prior、资源选择、未知期望 | value/CardValue | 明确是静态机会价值，不是完整行动价值 |

硬不变量：

1. 最终 transition value = 一次 state delta + 明确未落入状态的互斥流量 + 一次 frontier residual + 有证明的 domain marginal。
2. prior 不进入最终 value；diagnostic ledger 开关不能改变生产选择。
3. 同一张牌的实体价值、支付成本和状态损失不得以三个名字重复扣除。
4. 反事实 baseline 与 boosted world 只能改变被测因素，其余概率世界必须配对。

## 11. Simulator 函数所有权图

`AiSimulator` 当前函数按职责分组如下；这是拆分依据，不是建议机械一函数一文件。

| 函数组 | 代表函数 | 当前职责 | 目标 |
|---|---|---|---|
| SearchState 基础 | constructor、clone、initializers、sync summaries | 克隆与规范化 | `simulation/Simulator` + `state/SearchState` |
| 概率资源账 | block/counter distributions、event worlds、energy/shield worlds、slots | 概率守恒、容量消费 | `state/Probability` + `simulation/ResponseSimulation` |
| 牌身份/资源 | add/transfer/consume known/unknown cards、estimates、discard/resource selection | 实体与期望资源守恒 | `simulation/CardEffectSimulation`，Policy 只提供选择 |
| 动作分派 | `apply`、`applySkill` | 抽象动作到效果 | `simulation/Simulator` facade + Card/Skill adapters |
| 卡牌/技能效果 | assault、duel、tracking、gamble、coordination、plunder/destroy 等 | 具体模拟镜像 | CardEffect/SkillEffect/CombatSimulation |
| 响应/反制 | block/counter capacity、scope/target counter、desire/dynamic gain | 响应资源+策略混合 | ResponseSimulation；desire 移 Policy |
| 战斗生命周期 | guardian、after damage、`applyDamage`、`applyHpLoss`、`resolveFatal`、heal | 伤害、濒死、击杀镜像 | CombatSimulation + StatusSimulation |
| 延迟状态 | radar、lightning hit、seal/lightning branches | 状态域镜像 | StatusSimulation + domain models |

最危险的边界是：模拟器一边选择资源/响应，一边修改分布与状态。迁移时先固定 SearchState 不变量和效果契约，再拆 façade；不能先移动文件再解释概率守恒。

## 12. Evaluator、Planner 与 ActionGenerator 所有权

### Evaluator

- `playerValueTerms`、`ownerStateTerms`、`stateUtility`：KEEP 为 State Value 核心。
- `ownerStateLedger`、`projectOwnerLedger`：MOVE 到 ValueLedger。
- `cardOpportunityCost`、角色牌差量调用：MOVE 到 CardValue/Economics。
- `frontierResidual`：MOVE 到 FrontierValue，并限定终点一次性使用。
- `actionUtility`、`actionSearchPrior`：MOVE 到 SearchPolicy；只做排序。
- `actionEconomicValue`：MOVE 到 Economics，并逐项证明不在 state delta。
- lightning lifecycle 系列：MOVE 到 LightningModel/ThreatValue；Evaluator 不再构造 Simulator。
- exposure、radar mitigation、shield/HP risk：SPLIT 为 ThreatValue 与 State Value terms。

### Planner

- `plan` 的 beam/frontier/yield/budget：KEEP 为通用 Planner。
- `describeAction`、stable descriptor：MOVE 到 controller/action descriptor adapter。
- `evaluateExposeMarginal`、assault stack provenance：MOVE 到 domain/skill transition model。
- response counterfactual/ledger：MOVE 到 ValueLedger + ResponseSimulation query。
- `computeCandidateLedger`、`composeCandidateValue`：MOVE 到 TransitionValue。
- `chooseCandidate`、randomness/tie-break：MOVE 到 SearchPolicy。
- Generator、Knowledge 改为构造注入，删除所有 `game.aiController` 回指。

### ActionGenerator

- 根/深层的规则合法动作枚举：KEEP 为 ActionGenerator，但统一接收只读状态接口。
- 次数槽与执行世界：与 SearchState/Probability 契约对齐。
- 3v1 禁雷、零收益孤注/破势：MOVE 到 SearchPolicy/domain filter；合法动作集合与策略候选集合分离。
- 转移组合选择：MOVE 到 TransferPolicy，显式注入。
- 卡牌/技能合法性镜像：长期改为共享 Rule Projection；现阶段由契约测试保护。

## 13. Policy、State 与 Domain 深度审计

### AiResponsePolicy

- 濒死、格挡、护援、反制入口属于 ResponsePolicy。
- 状态构造移出 Policy，由 Controller/ResponseSystem 提供受限 DecisionContext。
- Simulator 构造移出 Policy，改为注入只读的 ResponseSimulation query。
- lightning、seal、global-benefit 公式移到 domain；Policy 只比较响应净值与机会成本。

### AiVisibleState

- GameState → VisibleState 只做合法投影。
- remaining-count、expected counts 和 distributions 转到 BeliefState builder。
- mutable search counters、概率槽、terminal 标记转到 SearchState factory。
- `TeamRuleService` 与 active skill cost 属合法公开规则投影；角色静态牌值不应污染 VisibleState。

### sealScoring / lightningScoring

- 二者都应 RENAME 为 Domain Model。
- 状态存在概率、判定类别、传播/结局属于 domain。
- 威胁/机会价值属于 value terms。
- seal delay 的 sibling comparison 属 search transition。
- RuleEngine/Distance 调用属于规则投影，必须明确是共享权威还是镜像。

### transferScoring

- 候选与组合选择属于 TransferPolicy。
- 静态卡牌情境价值归 CardValue。
- threat view 归 ThreatValue。
- unknown hand expectation 使用 BeliefState，不自行读取 remaining counts。

### AiGlobalBenefit

- 互利/共生结果模型归 GlobalBenefitModel。
- counter desire 与机会成本归 ResponsePolicy/Economics。
- root state 解析归 CardEffectSimulation。
- dynamic root flip 是受限 counterfactual query，不应让 domain 反向持有 Evaluator/Simulator。

## 14. 性能风险图

| 热点 | 当前证据 | 风险 | 迁移观测量 |
|---|---|---|---|
| SearchState clone | 每个 Simulator apply/分支克隆大量嵌套摘要 | 分配和 GC；身份字段复制错误 | clones/node、bytes/node、clone time |
| 重复 simulation | Evaluator lightning、Planner response/expose、Policy counterfactual 各自启动模拟 | 同一候选重复推演 | apply calls/root、counterfactual cache hit |
| diagnostics | owner/response/candidate ledger 可按候选生成 | 诊断开关影响热路径或语义 | diagnostics on/off 选择完全一致、耗时差 |
| 概率世界 | hidden samples × beam × block/counter/availability partitions | 组合爆炸 | worlds/root、merge ratio、pruned mass |
| repeated `stateUtility` | before/after、sibling、frontier 多次全量评估 | 大状态重复扫描 | stateUtility calls/node、memo hit |
| repeated RuleEngine/Distance | 根动作、深层动作、domain timing 重复合法性计算 | CPU 与镜像分歧 | legality calls/node、cache key correctness |
| dynamic counter/root flip | 每个 responder/target scope 构造反事实 | 战术多目标时爆发 | simulations/counter decision |
| probability diagnostics | 多个分布持续 normalize/merge | 小概率尾部和浮点开销 | branches before/after merge、lost mass |

性能优化不得先于语义 owner 分离。缓存键必须包含 SearchState 版本、viewer、actor、概率条件和实体身份；任何缓存都要用固定节点/固定 seed 的等价测试和 benchmark 证明。

## 15. 目标架构

目标依赖方向：

```text
core/Game + ResponseSystem
          |
          v
ai/controller/AIController  (composition root / stable facade)
          |
          +--> state/VisibleState -> state/Knowledge -> state/BeliefState
          |                                  |
          |                                  v
          +--> search/Planner -> search/ActionGenerator -> RuleProjection
          |          |            |
          |          v            v
          |     simulation/Simulator facade
          |          +--> CombatSimulation
          |          +--> ResponseSimulation
          |          +--> CardEffectSimulation
          |          +--> SkillEffectSimulation
          |          +--> StatusSimulation
          |
          +--> value/Evaluator -> ValueLedger, Economics, CardValue, ThreatValue
          +--> policy/ResponsePolicy, CardSelectionPolicy,
          |          ResourceSelectionPolicy, TransferPolicy
          +--> domain/LightningModel, SealModel, GlobalBenefitModel

state/SearchState + state/Probability are shared low-level value objects.
UI is outside every search/simulation/value dependency cone.
```

目标目录只是责任地图。只有在一个阶段能证明 owner、API、测试和回滚时才创建实际文件，禁止为“看起来分层”批量搬空旧模块。

## 16. 目标 API 约束

- Controller 是唯一 composition root；上游不再访问 `.planner`、`.evaluator`、`.cardSelector` 等可变内部对象，迁移期可保留只读兼容 façade。
- Planner 构造参数显式包含 `actionGenerator`、`simulatorFactory`、`evaluator`、`searchPolicy`、`beliefProvider`；不得持有 Game。
- ActionGenerator 接收 `RuleProjection` 和策略过滤器；`generateLegal` 与 `rank/filterCandidates` 分离。
- Simulator façade 接收 SearchState 和纯效果规格，返回新 SearchState/Transition；不接收 UI、Game 或 AIController。
- Evaluator 是纯读取；不得 `new Simulator`。
- Policy 接收 DecisionContext 与只读 query，不拥有状态投影或游戏结算。
- Domain model 返回概率结果或领域 terms，不反向依赖 Planner/Evaluator/Simulator concrete class。

## 17. Architecture Guard 路线

当前门禁只执行可可靠判定的规则：

1. `js/ai/state/**`、`search/**`、`simulation/**`、`value/**` 新增 UI import 时失败。
2. 变更的 `js/ai/**` 新增 `game.aiController`/`this.game.aiController` 回指时失败。
3. 变更函数缺 Function Header v1 字段时失败。
4. `js/ai/state/**` 反向 import `AiController`、`AiPlanner`、`AiSimulator` 或 `AiEvaluator` 时失败。

后续在目录和 API 稳定后增加：

- Planner concrete import domain implementation；
- 跨层非法 import；
- Simulation 写 GameState 或读取 UI；
- Value 构造 Simulator；
- HiddenInfo 标注/fixture；
- 规则权威与镜像契约覆盖清单。

Guard 必须从解析到的 import、路径层和明确语法事实得出结论。禁止靠单词黑名单扫描注释或变量名制造假门禁。

## 18. 分阶段迁移计划

所有阶段共用冻结条件：保持 AI 决策行为，除阶段明确批准的 bug 外不改规则/平衡；浏览器 JS 变更统一 build；直接测试后跑完整入口、质量门禁、build 一致性和 diff 检查；每阶段可独立回滚。

### AI-ARCH-2：State Contract

- 来源 → 目标：`AiVisibleState`、`AiKnowledge`、`AiProbabilityBranches` → `state/{VisibleState,Knowledge,BeliefState,SearchState,Probability}`。
- 移动：观察投影、记忆、remaining counts、world samples、SearchState 初始化、通用分支代数。
- 不移动：雷达判定进入 Radar/Lightning domain；Simulator 的状态效果暂留。
- API/import：Controller 先构造 Visible+Belief，再由 SearchState factory 转换；保持旧 façade 兼容。
- 测试：隐藏牌互换不改变决策、记忆失效、输入只读、branch mass、clone isolation。
- 风险/回滚：字段遗漏和样本 seed 漂移；保留旧工厂并做双构造深比较后切换。

### AI-ARCH-3：Dependency Injection and Controller Boundary

- 来源 → 目标：Planner/Generator 的 `game.aiController` 回指 → Controller 显式注入。
- 移动：descriptor resolver 与 composition；不移动搜索/评分逻辑。
- API/import：Planner 无 Game；Generator 注入 TransferPolicy；上游逐步使用稳定 façade。
- 测试：独立构造组件、现有搜索序列、descriptor 重绑、Supervisor Architecture Guard。
- 风险/回滚：测试 monkey patch 依赖公开子组件；保留兼容 getter 一个阶段。

### AI-ARCH-4：Value Ownership

- 来源 → 目标：Evaluator/Planner/domain scoring → `value/{Evaluator,ValueLedger,Economics,CardValue,ThreatValue}` 与 `search/TransitionValue`。
- 移动：ledger、prior、economic、frontier、transition composition；不移动 Simulator 效果。
- API/import：Evaluator 纯函数化并禁止构造 Simulator。
- 测试：state delta baseline invariance、response mutual exclusion、frontier once、diagnostic parity、opportunity-cost no double count。
- 风险/回滚：数值微差改变 tie-break；逐 term 快照和旧/新双算对比。

### AI-ARCH-5：Policy Extraction

- 来源 → 目标：CardSelector、ResponsePolicy、resource/discard/transfer helpers、Generator 策略过滤 → `policy/**`。
- 移动：选择与意愿；不移动合法性、实际实体结算、domain 结果模型。
- API/import：DecisionContext + typed query；Policy 不构造 VisibleState/Simulator。
- 测试：隐藏选择公平、转移一致、响应链、护援/救援、合法动作与策略候选分离。
- 风险/回滚：执行 token 与未知定义泄露；保留旧 Selector façade 委托新策略。

### AI-ARCH-6：Domain Models

- 来源 → 目标：lightning/seal/global-benefit 与雷达分支 → `domain/{LightningModel,SealModel,GlobalBenefitModel,RadarModel}`。
- 移动：概率结局与领域 terms；不移动 Search sibling timing、Response desire、真实 Judgment。
- API/import：domain 依赖 State/RuleProjection，不依赖 concrete Planner/Evaluator/Simulator。
- 测试：remaining-count 判定、传播、封印时序、互利座次、未来 RNG 隔离。
- 风险/回滚：概率尾差和 owner team 投影；旧函数转发并做分布容差比较。

### AI-ARCH-7：Simulation Facade and Response/Combat Split

- 来源 → 目标：Simulator 的伤害、格挡、反制、濒死、护援 → CombatSimulation/ResponseSimulation。
- 移动：概率资源消费与战斗生命周期；不移动卡牌/技能分派。
- API/import：Transition + effect worlds；Policy 仅提供 desire query。
- 测试：与 Game/Response/Dying 权威的表驱动差分、概率守恒、重复实体消费、击杀奖励。
- 风险/回滚：事件顺序/概率容量；Simulator façade 同时支持旧/新实现开关用于测试，不进生产配置。

### AI-ARCH-8：Card/Skill/Status Simulation Split

- 来源 → 目标：Simulator `apply` 的卡牌、技能、延迟状态分支 → CardEffect/SkillEffect/StatusSimulation。
- 移动：纯 SearchState 效果镜像；不移动 RuleEngine/cardRegistry/skillRegistry 权威。
- API/import：按 definition/skill adapter 注册，未知 ID 显式失败。
- 测试：每张牌、每角色技能、雷电/封印、取消/死亡/状态变化、真实权威差分。
- 风险/回滚：注册遗漏和调用顺序；按小批 definition 迁移并保留 fallback，全部覆盖后删除。

### AI-ARCH-9：Search Core

- 来源 → 目标：Planner beam、candidate composition、tie-break → `search/{Planner,SearchPolicy,TransitionValue}`。
- 移动：通用搜索；不移动 domain marginals，改为 hooks/terms。
- API/import：Planner 仅依赖接口和值对象；Architecture Guard 禁 concrete domain/service locator。
- 测试：固定节点/seed 序列、end fallback、预算、取消、frontier、隐藏样本一致。
- 风险/回滚：遍历顺序改变同分结果；锁定 stable action key 和旧/新 trace 对比。

### AI-ARCH-10：Remove Compatibility and Performance Pass

- 来源 → 目标：旧 façade、旧文件转发、重复镜像 helper → 正式分层 API。
- 移动：无；只删除已无调用的兼容层并在语义冻结后优化 clone/cache。
- API/import：上游只依赖 Controller 公共入口；启用更完整 Architecture Guard。
- 测试：完整功能、AI benchmark、适用时 Balance、quality `--all` 基线、性能报告。
- 风险/回滚：隐藏动态调用与缓存错误；删除前 `rg`+覆盖率证据，性能改动逐项独立提交。

## 19. 阶段验收与停止规则

每一阶段必须提交以下证据后才能进入下一阶段评审：

- source/target owner 表与未移动职责；
- current/target import diff 和新 API；
- 相关测试、完整测试、质量门禁、build 版本测试（浏览器资源变更时）；
- hidden-info fixture 与性能观测影响；
- `git diff --stat`、`git diff --check`、无关改动确认；
- 回滚点和仍存在的兼容层。

若无法唯一确定规则权威、价值 owner 或概率世界不变量，停止迁移并补证据，不以“先拆文件再说”推进。

## 20. AI-ARCH-1 结论

当前 AI 已具备可见状态过滤、隐藏世界采样、有限深度搜索、概率响应和较强的回归测试，但边界主要靠开发纪律而非结构保证。优先级最高的架构债务依次是：

1. Visible/Belief/Search 状态混合；
2. Planner/Generator 通过 `game.aiController` 回指；
3. Simulator 兼任状态、效果、响应、战斗与选择策略；
4. Evaluator 启动 Simulation，价值 owner 与 domain 反事实交织；
5. 规则镜像面积大但缺统一权威差分契约；
6. 概率世界与 repeated evaluation 的性能成本缺结构化观测。

因此 AI-ARCH-2 应从 State Contract 开始，而不是先拆 Simulator 或移动目录。状态和信息边界未稳定前，后续任何分层都会把同一混合对象传播到更多模块。

## 21. AI-ARCH-2 State Field Ownership Table

本表依据当前生产字段的实际生产者和消费者建立。`AiVisibleState` 目前输出的是兼容 SearchState，表中的目标 owner 描述语义所有权，而不是旧文件位置。

| Field | Current Producer | Current Consumers | Meaning | Target Owner | Mutability | Hidden-info classification | Migration decision |
|---|---|---|---|---|---|---|---|
| `gameId/currentRound/phase` | AiVisibleState ← GameState | Planner（gameId）；其余仅透传 | 已确定的对局与阶段事实 | VISIBLE | Visible 中不可变 | LEGAL OBSERVATION | MOVE 到 VisibleState；SearchState 共享投影 |
| `deckCount/discardCount/discardDefinitionIds/judgmentDefinitionIds/publicPool` | AiVisibleState ← 公开牌区 | 当前 AI 无直接读取，测试/后续模型可读 | 已公开牌区事实 | VISIBLE | 数组与条目不可变 | LEGAL OBSERVATION | MOVE 到 VisibleState，不复制完整牌对象 |
| `playPhaseEnded` | AiVisibleState 固定 false，Simulator 推进 | Generator、Planner、Simulator | 搜索路径终止标记 | SEARCH | 仅 Search clone 可写 | LEGAL OBSERVATION 派生 | MOVE 到 SearchState |
| `remainingCardCounts` | AiKnowledge 计算，AiVisibleState 复制 | Generator、Simulator、Evaluator、Knowledge、Lightning/Seal | 依据公开区、自己手牌和合法记忆得到的未知池 | BELIEF | 每个根状态不可变；分支克隆隔离 | BELIEF | MOVE 计算与快照到 BeliefState；Knowledge 保留兼容委托 |
| `players[].id/seatIndex/name/controllerType/battleTeam/generalId/tags/roleTags` | AiVisibleState ← Player/general | 几乎全部 AI 模块 | 公开身份、座次与阵营事实 | VISIBLE | 不可变 | LEGAL OBSERVATION | MOVE 到 VisibleState |
| `Visible.players[].hp/maxHp/shield/energy/maxEnergy/alive` | AiVisibleState ← Player | Generator、Evaluator、Planner、Policy、Simulator、Domain | 根节点确定资源与生存事实 | VISIBLE | 不可变 | LEGAL OBSERVATION | MOVE 到 VisibleState |
| `Search.players[].hp/shield/energy/alive` | SearchState 初始化，Simulator 推进 | Generator、Evaluator、Planner、Simulator | 分支中的模拟资源与生存状态 | SEARCH | Search clone 可写，兄弟节点隔离 | 不得回读 GameState | MOVE 初始化/clone contract；效果更新暂留 Simulator |
| `attackRange/attackUsed/attackLimit/recoverUsed/recoverLimit` | AiVisibleState ← turn flags/rules | Generator、Evaluator、Simulator、Transfer/Seal | 根节点确定的本回合规则事实 | VISIBLE | Visible 不可变；Search mirror 可写 | LEGAL OBSERVATION | Visible 保存初值，SearchState 建立可变镜像 |
| `attackUseSlots` | AiVisibleState，Simulator 消费 | Generator、Evaluator、Simulator | 概率世界中的攻击次数资源 | SEARCH | Search clone 可写 | BELIEF/SEARCH 条件世界 | MOVE 初始化到 SearchState |
| `momentum/categoriesUsed/gambleTriggered/coordinationTriggered/rejuvenationTriggerCount` | AiVisibleState ← turn flags | Simulator、Evaluator、Policy | 根节点已确定的技能/回合事实 | VISIBLE | Visible 不可变；Search mirror 可写 | LEGAL OBSERVATION | MOVE 确定事实到 VisibleState |
| `momentumBranches/categoryUsedProbabilities/categoryUsedStateBranchesByCategory` | AiVisibleState，Simulator 规范化/消费 | Simulator | 分支相关的连势与类别使用状态 | SEARCH | Search clone 可写 | SEARCH | MOVE 初始化到 SearchState |
| `guardianAidUsedProbability/spyGapTriggeredProbability/gambleTriggeredProbability/coordinationTriggeredProbability` | AiVisibleState，Simulator 更新 | Simulator | 技能触发额度在概率分支中的剩余质量 | SEARCH | Search clone 可写 | SEARCH | MOVE 初始化到 SearchState |
| `exposeWeaknessStacks/assaultBonus` 根事实 | AiVisibleState ← statuses | Planner、Evaluator、Generator、Policy、Simulator | 公开状态的确定初值 | VISIBLE | Visible 不可变 | LEGAL OBSERVATION | MOVE 初值到 VisibleState；后续分支值属于 Search |
| `activeSkillId/activeSkillUses/activeSkillLimit/activeSkillUsed` | AiVisibleState ← general/turn flags | Generator、Evaluator、Simulator、Seal/Transfer | 确定技能身份与当前使用次数 | VISIBLE | Visible 不可变；Search mirror 可写 | LEGAL OBSERVATION | MOVE 到 VisibleState |
| `activeSkillAvailabilityBranches/activeSkillUseSlots` | AiVisibleState，Simulator 消费 | Generator、Simulator | 技能次数在概率世界中的资源槽 | SEARCH | Search clone 可写 | SEARCH | MOVE 初始化到 SearchState |
| `activeSkillCost/nextTurnBaseAttackLimit/turnEnergyGainWithoutEquipment/energyDeviceTurnEnergyGain` | AiVisibleState 调用 Rule/Team services | Generator、Evaluator、Simulator、Seal/Transfer | 公共规则的确定派生结果 | DOMAIN | 根快照不可变；Simulator 可按模拟装备重新同步 cost | LEGAL OBSERVATION 派生 | 暂由兼容 façade 计算并注入 SearchState；不伪装成 Visible owner |
| `recycleDeviceUses/trackingTargetIds/trackingUses/huntMarkSourceId` | AiVisibleState ← turn flags/status | Evaluator、Generator、Simulator | 确定的公开装备/技能状态 | VISIBLE | Visible 不可变；Search mirror 可写 | LEGAL OBSERVATION | MOVE 初值到 VisibleState |
| `huntMarkProbability/huntMarkProbabilities/huntMarkStateBranchesBySource` | AiVisibleState，Simulator 更新 | Generator、Evaluator、Simulator | 猎印在条件世界中的存在质量 | SEARCH | Search clone 可写 | SEARCH | MOVE 初始化到 SearchState |
| `handCount` | AiVisibleState 只读取长度 | Generator、Evaluator、Planner、Simulator、Domain | 所有玩家公开手牌数量 | VISIBLE | Visible 不可变；Search mirror 可写 | LEGAL OBSERVATION | MOVE 到 VisibleState |
| `hand`（仅 viewer 的 `{id, definitionId}`） | AiVisibleState ← viewer.hand | Generator、Evaluator、Planner、Simulator | 观察者合法知道的自己手牌 | VISIBLE | Visible 中不可变；Search clone 消费 | LEGAL OBSERVATION | MOVE 确定身份到 VisibleState；availability 分支由 SearchState 添加 |
| `knownCards` | AiVisibleState ← viewer.aiMemory | Simulator、Seal、Transfer、Belief sampling | 合法窥探所得 card ID/definition | KNOWLEDGE | Knowledge snapshot 不可变；真实记忆由 Game 失效 | MEMORY | MOVE 到 KnowledgeState；仅在兼容 SearchState 中投影 |
| `equipmentDefinitionId/statuses` | AiVisibleState ← 公开装备/状态 | Generator、Evaluator、Policy、Simulator、Domain | 公开装备和状态事实 | VISIBLE | Visible 不可变；Search mirror 可写 | LEGAL OBSERVATION | MOVE 到 VisibleState |
| `equipmentRetentionProbability` | AiVisibleState 固定 0/1，Simulator 更新 | Generator、Selector、Evaluator、Simulator、Domain | 模拟世界中装备仍存在的概率质量 | SEARCH | Search clone 可写 | SEARCH | MOVE 初始化到 SearchState |
| `expectedRecoverCount` | AiVisibleState 的未知牌估计，Simulator 更新 | Planner、Simulator | 已知调息数加未知手牌期望 | BELIEF | 根 Belief 不可变；Search mirror 可写 | BELIEF | MOVE 初始推导到 BeliefState |
| `blockProbability/twoBlockProbability/blockCountDistribution` | AiVisibleState 的未知牌估计，Simulator 更新 | Planner、Simulator | 格挡数量分布及派生概率 | BELIEF | 根 Belief 不可变；Search mirror 可写 | BELIEF | MOVE 初始推导到 BeliefState；概率代数不变 |
| `counterProbability/counterCountDistribution` | AiVisibleState 的未知牌估计，Simulator 更新 | Planner、Simulator、GlobalBenefit、Seal | 反制数量分布及派生概率 | BELIEF | 根 Belief 不可变；Search mirror 可写 | BELIEF | MOVE 初始推导到 BeliefState |
| `expectedAssaultCount/assaultResponseProbability/assaultCountDistribution` | AiVisibleState 的未知牌估计，Simulator 更新 | Evaluator、Simulator、Seal | 突袭数量分布及派生概率 | BELIEF | 根 Belief 不可变；Search mirror 可写 | BELIEF | MOVE 初始推导到 BeliefState |
| `shieldBranches/energyBranches` | AiVisibleState 固定确定分支，Simulator 更新 | Simulator | 资源在条件世界中的状态分区 | SEARCH | Search clone 可写 | SEARCH | MOVE 初始化到 SearchState |
| 手牌/known card `availabilityBranches/availabilityStateBranches` | AiVisibleState 固定可用，Simulator 消费 | Generator、Simulator | 同一实体在条件世界中的可用质量 | SEARCH | Search clone 可写 | SEARCH；身份来源仍为 VISIBLE/KNOWLEDGE | MOVE 初始化到 SearchState，保持 card ID 不重复消费 |
| `initialEquipmentValue/initialEquipmentRoleDelta` | AiVisibleState/AiSimulator | Evaluator、Simulator | 价值比较的根装备基线 | VALUE | 根基线固定 | LEGAL OBSERVATION 派生 | 暂由 compatibility façade 注入；ARCH-4 迁入 Value |
| `expectedEquipmentGain/expectedEquipmentRoleDelta/expectedInformationGain` | AiVisibleState 固定 0，Simulator 更新 | Evaluator、Simulator | 搜索转移产生的价值账字段 | VALUE | Search clone 中可写 | SEARCH 派生，不含隐藏牌定义 | 暂由 SearchState 承载兼容字段；owner 留给 ARCH-4 |

### Contract 结论

- VisibleState 只保存确定事实，不保存 `remainingCardCounts`、牌概率、搜索分支或价值分数。
- KnowledgeState 只保存 viewer 的合法 card-ID 记忆；remaining counts 与 hidden worlds 属 Belief。
- BeliefState 只保存由 VisibleState、KnowledgeState 和 remaining counts 推导的根不确定性，不承载模拟生命周期。
- SearchState 组合上述不可变投影并创建可写的搜索资源镜像；Simulator 只克隆和推进 SearchState，不能回读 GameState。
- DOMAIN/VALUE 字段本阶段通过显式 derived input 保持兼容，不为迁移整洁而提前进入 ARCH-4/6。

## 22. AI-ARCH-2 落地结果

### 运行时契约

当前状态组合路径为：

`GameState -> VisibleState + KnowledgeState -> BeliefState -> SearchState`

- `state/VisibleState.js` 是公开事实和观察者本人手牌投影的唯一 owner；输出普通不可变对象，不保留 `Game`/`Player` 引用。
- `state/Knowledge.js` 是观察者合法 card-ID 记忆快照的唯一 owner；历史 `AiKnowledge` 路径只重导出兼容类。
- `state/BeliefState.js` 拥有 remaining counts、隐藏牌分布与 hidden worlds；推导只使用公开牌区、观察者手牌、合法记忆和未知槽位数。
- `state/SearchState.js` 只组合已经过滤的三个契约和显式注入的 DOMAIN/VALUE 结果；`cloneSearchState` 只深克隆 SearchState，不接受或回读 GameState。
- `state/Probability.js` 拥有领域无关的概率分支代数；`AiProbabilityBranches.js` 仅保留雷达判定领域模型并重导出旧通用 API。

`createAiVisibleState` 的历史命名暂时保留，但它已是 `createAiStateContracts(...).searchState` 的单行 compatibility façade。Planner、ResponsePolicy 与现有测试因此继续消费原扁平字段；后续迁移不得在该旧文件恢复第二套投影或概率实现。

### 未移动职责

- Simulator 的卡牌、技能、战斗、响应、延迟状态与概率效果推进保持原位。
- expose/seal/response ledger、Transition Value、Evaluator 与 Controller 回指保持原位，分别留给后续既定阶段。
- `activeSkillCost`、下回合攻击次数、能量派生与初始装备价值仍由现有 Rule/Team/Value 权威计算，再作为 `derivedPlayersById` 注入 SearchState；这不代表 State 获得领域或价值所有权。

### 自动边界

Architecture Guard 现已覆盖 `state/**` 的模块头与 UI import 禁令，并禁止 State 反向 import Controller、Planner、Simulator 或 Evaluator。该规则只检查静态 import 路径，不扫描注释或变量关键词。

### 行为与性能基线

- 同一五人夹具下，HEAD 旧工厂和新 compatibility façade 的 SearchState 深比较完全一致，序列化大小均为 14,720 bytes；Visible/Knowledge/Belief 是小型分层投影，只有 SearchState 进行一次最终扁平组合，没有再复制三个完整大状态。
- 同一进程五轮中位数下，1,000 次状态组合：HEAD 旧工厂 19.883 ms，新四层组合 27.494 ms；根状态每次组合增加约 7.611 微秒。该入口每次 AI 决策只执行一次，新增成本来自显式创建小型分层契约。
- 同一进程五轮中位数下，1,000 次 `AiSimulator.clone()`：HEAD 旧实现 110.411 ms，新实现 108.526 ms；搜索热点克隆未退化。直接深克隆中位数为旧 67.480 ms、新 73.233 ms，差异属于相同 `structuredClone` 外增加一层稳定入口的观测成本。
- State/Knowledge/动态密度关键回归：改造前 56 项耗时 190 ms；改造后同组加 6 项 State Contract 共 62 项耗时 166 ms。

以上观测用于发现结构迁移造成的明显退化，不构成跨机器性能承诺，也没有在本阶段引入缓存或主动性能优化。

### 当前回滚与兼容边界

可独立回滚的物理边界是 `state/**`、`AiVisibleState` composition façade、`AiKnowledge` 重导出、通用 Probability 重导出和 Simulator clone 委托。仍需后续移除的债务包括旧 `createAiVisibleState` 命名、Planner 对扁平 SearchState 的直接字段依赖、DOMAIN/VALUE 派生注入以及 Simulator 内部状态初始化兼容函数。
