FiveRealms AI 引擎 —— 最终架构说明

当前状态： FINAL RESIDUE DELETION COMPLETE
架构状态： 18 文件 AI 架构已冻结
执行硬规则： 每执行一个真实 Action 后，必须基于最新真实 World 重新搜索
文档用途： 本文只描述当前正式生产架构。历史文件名只允许出现在“历史吸收表”中，不再拥有任何当前职责。

0. 文档目的

本文是 FiveRealms AI Engine 当前版本的正式架构说明与最终约束。

本文统一规定：

最终 18 个 AI 生产文件；

唯一 canonical 数据结构；

合法性、搜索、模拟、概率、价值、真实运行边界分别由谁负责；

两条合法执行路径：

完整战略搜索；

已进入结算后的局部轻量响应；

Main / Worker 的统一组合方式；

每个真实 Action 执行后的强制重新搜索；

禁止的跨层依赖和重复 authority；

复杂度与性能门禁；

历史模块到最终 owner 的吸收关系。

最高原则：

ARCHITECTURE
- 职责单一
- 同一语义只保留一套 canonical 数据
- 无重复 authority
- 无隐藏反向依赖
- 无兼容旧架构

SEMANTICS
- 合法动作能力不丢
- 模拟规则不丢
- 概率语义不丢
- 价值知识不丢
- Pattern / 战略知识不丢

COMPLEXITY
- 消灭跨 transition branch genealogy
- 禁止无界乘法概率扩张
- 只允许有明确上界的局部 N×M
- 减少 clone / materialization / DTO conversion

PERFORMANCE
- 相同 SearchBudget 不得降低 root coverage 或决策质量
- 性能收益应转化为更充分的有效搜索

INTELLIGENCE
- 搜索模拟中的响应判断与真实结算中的响应判断必须共享同一价值语义
- 每执行一个真实 Action，旧搜索未来序列立即失去“可直接执行”的资格

1. 最终物理结构

正式生产 AI 目录精确为：

js/ai/
│
├─ Controller.js
│
├─ Generator/
│  ├─ Generator.js
│  └─ Action.js
│
├─ Searcher/
│  ├─ Searcher.js
│  ├─ Rng.js
│  └─ Pattern.js
│
├─ Event/
│  ├─ Fact.js
│  └─ Probability/
│     ├─ Probability.js
│     ├─ Branch.js
│     └─ Pool.js
│
├─ Simulator/
│  ├─ Simulator.js
│  ├─ World.js
│  ├─ Damage.js
│  ├─ Resource.js
│  └─ Response.js
│
└─ Evaluator/
   ├─ Evaluator.js
   ├─ StateValue.js
   └─ CardValue.js

总计：

18 个 production AI files

18 个物理文件不代表 18 个独立业务 authority。

主要跨职责 facade：

Controller.js
Generator/Generator.js
Generator/Action.js
Searcher/Searcher.js
Event/Fact.js
Event/Probability/Probability.js
Simulator/Simulator.js
Simulator/World.js
Evaluator/Evaluator.js

默认 internal implementation module：

Searcher/Rng.js
Searcher/Pattern.js

Event/Probability/Branch.js
Event/Probability/Pool.js

Simulator/Damage.js
Simulator/Resource.js
Simulator/Response.js

Evaluator/StateValue.js
Evaluator/CardValue.js

2. 五个核心“器”的职责

整个架构可以只记住五个问题：

Generator
= 现在有哪些合法动作？

Simulator
= 做了这个动作以后会发生什么？

Evaluator
= 这个结果好不好、这个响应值不值得？

Searcher
= 综合未来推演以后，现在应该选择哪个战略 Action？

Controller
= 真实游戏如何进入 AI，又如何把 AI 结果送回真实游戏？

这五个职责不得互相吞并。

3. 执行模型

当前 AI 有两条正式执行路径。

两条路径共享同一套 World、Probability、Simulator、Evaluator 语义，只是决策规模不同。

3.1 完整战略搜索

AI 正常出牌阶段的顶层战略决策走完整链：

```text
                         REAL GAME
                            │
                            ▼
                       Controller
                            │
                            ▼
                       Generator
                            │
                      canonical Action[]
                            │
                            ▼
                        Searcher
                 ┌──────────┼──────────┐
                 │          │          │
                 ▼          ▼          ▼
              Pattern      Rng      Simulator
                                      │
                              ┌───────┼───────┐
                              ▼       ▼       ▼
                           Damage  Resource Response
                              │       │       │
                              └───────┼───────┘
                                      ▼
                                    World
                                      │
                                      ▼
                                  Evaluator
                                  /       \
                                 ▼         ▼
                           StateValue   CardValue

                         Event
                         ┌───────────────┐
                         │ Fact          │
                         │ Probability   │
                         │  ├─ Branch    │
                         │  └─ Pool      │
                         └───────────────┘
```

---

适用于：

出哪张牌
发动哪个主动技能
选择哪个目标
选择哪个目标组合
破坏什么
掠夺什么
转移什么
先做什么、后做什么
要不要结束出牌阶段

Searcher 可以在内部搜索完整未来序列：

A → B → C → D

B / C / D 的作用是：

帮助判断 A 的未来价值

它们不构成真实游戏未来必须执行的计划。

3.2 每执行一个真实 Action 后强制重新搜索

这是硬性执行规则。

Searcher 内部可以得到：

bestSequence = A → B → C

真实游戏只接收：

A

A 真正执行以后：

REAL GAME 已变化
        ↓
重新建立最新 canonical World
        ↓
Generator
        ↓
Searcher
        ↓
重新选择当前最佳 root Action

旧 B、C 不能进入真实执行队列。

生产代码禁止重新出现：

replanAfterEveryAction 开关
aiReplanAfterEveryAction
queuedPlan
plannedActions
acceptedPlannedSequence
resolvePlannedAction
getPlannedSequence
future-action execution queue

允许保留：

Searcher.lastSequence
stats.bestSequence

但只能用于：

搜索价值传播
诊断
benchmark
debug

禁止：

bestSequence → Controller 后续真实执行队列
bestSequence → TurnWorkflow 下一步真实动作
bestSequence[1..] → 自动真实执行

核心原因：

旧 B 仍然合法
≠
旧 B 在新的真实 World 中仍然最优

3.3 已进入真实结算后的局部轻量响应

当一个较大的 Action 已经进入真实结算，而且正式游戏规则已经把当前选择压缩成非常小的局部决策时，不启动完整多步 Searcher。

典型情况：

格挡 / 放弃
反制 / 放弃
护援 / 放弃
濒死救援 / 放弃
借势要求打出突袭 / 拒绝

已经翻开的公开牌池中选哪张
强制弃牌选哪几张
canonical 匿名牌选择绑定到哪张真实物理牌

局部响应链：

REAL GAME 结算事件
        ↓
Controller
        │
        ├─ 组织 data-only 当前上下文
        │
        ├─ 如需比较两个结果：
        │     Simulator 构造 STAY / RESPOND
        │     或其它 paired/outcome Worlds
        │
        ▼
Evaluator
        │
        ▼
局部响应 / 比较结果
        │
        ▼
Controller
        │
        ▼
REAL GAME 继续结算

简单公开牌 / 弃牌选择可以是：

Controller
   ↓
Evaluator 的局部选择 / 价值 primitive
   ↓
选中的局部对象

匿名物理实体绑定：

Controller
   ↓
现有 seeded Rng
   ↓
真实物理实体

这条轻量路径成立的前提：

当前战略空间已经由正式游戏规则压缩成一个很小的局部选择。

它不能演变成第二套战略搜索。

Controller 不得借这条路径：

重新枚举完整战略候选
逐个模拟完整战略候选
重新比较整回合 Action
复制 Searcher
自己写价值公式

如果某个“局部选择”重新形成明显的多动作 / 多步战略空间，就必须回到完整：

Generator → Searcher

3.4 搜索内部的响应预测

Searcher 模拟未来时，Simulator 也会遇到响应窗口。

例如：

Searcher
   ↓
Simulator 执行一个模拟 Action
   ↓
出现模拟 Block / Counter / Guardian / Rescue
   ↓
调用 Evaluator 拥有的响应判断 primitive
   ↓
Simulator 继续结算
   ↓
结果 World
   ↓
Searcher

逻辑依赖是单向的：

Simulator → Evaluator 的窄响应判断能力

当前实现通过 Controller 在 runtime composition 时注入窄能力。

Simulator 不拥有价值规则。

Evaluator 也不能持有或调用 Simulator。

允许：

Simulator
→ 注入的 Evaluator 响应判断 primitive

禁止：

Evaluator → Simulator
Evaluator → Controller
Evaluator → Searcher
Evaluator → 能制造 transition 的 callback

搜索模拟中的响应与真实结算中的响应，必须共享同一套 Evaluator 判断语义。

如果搜索为了性能使用有界近似输入，可以存在输入精度差异，但：

阈值
价值语义
最终响应规则

不得复制成第二套。

以后文档统一使用：

搜索模拟响应
真实结算响应

不要再把：

planning
runtime
willingness

当成架构层名称。

4. Main / Worker 搜索传输

Controller 是 AI search 唯一 public composition boundary。

真实调用链：

Controller.selectAction
        ↓
canonical SearchRequest envelope
        ↓
SearchExecutor
   ├─ LocalSearchExecutor
   └─ Worker
        ↓
WorkerSearchRuntime
        ↓
Controller.executeSearchRequest
        ↓
Controller.createSearchEngine
        ↓
Searcher
        ↓
当前 chosen root Action + diagnostics
        ↓
Controller acceptance

Worker 不能自己创建第二套：

Generator
Searcher
Simulator
Evaluator
Rng
Pattern

组合图。

Worker / Application 不得直接 import：

Searcher/Rng.js
Searcher/Pattern.js
Simulator/Damage.js
Simulator/Resource.js
Simulator/Response.js
Evaluator/StateValue.js
Evaluator/CardValue.js

允许存在 data-only 搜索传输 envelope。

这类 envelope 不是第二套 Action / World 模型。

可以包含：

request identity
canonical frozen World
canonical frozen root Actions
SearchConfig
Rng continuation
chosen canonical root Action
search diagnostics

不得包含：

另一套 SearchState
另一套 ActionDescriptor
另一套 SimulationState
另一套 EvaluationState
future executable Action queue
复制出来的 World schema

5. Controller.js

唯一职责

Controller 是：

真实 Game
↔
AI Engine

的唯一 runtime / composition public boundary。

负责：

Game → canonical World 边界

完整搜索入口

初始 Generator 调用

SearchRequest / Worker / SearchResult acceptance

Main / Worker runtime composition

AI Search Rng 初始化与延续

canonical selection
→ 当前真实物理实体绑定

已进入结算后的轻量响应编排

搜索基础设施故障时的安全 fallback

Controller 可以调用：

Generator
Searcher
Simulator facade
Evaluator facade
Fact / Probability facade
Rng

其中：

Controller → Simulator
Controller → Evaluator

只允许用于：

局部结算
局部响应
局部公开资源选择
真实实体绑定相关数据准备

Controller 不得拥有：

搜索算法
概率算法
transition 规则
价值公式
Pattern 战略知识
第二套资源 / Transfer mini-search
跨真实 Action 的未来执行队列

如果 Worker / search infrastructure 本身失败，可以安全选择 canonical：

end

这是容错，不是第二套战略 authority。

6. Generator/

6.1 Generator.js

Generator 唯一回答：

当前 canonical World 中有哪些合法 canonical Action？

负责：

动作枚举
目标枚举
selection 枚举
合法性过滤
canonical Action 构造
由 Action contract 定义的搜索等价去重

可以查询：

Domain Rules
Fact
Probability
Action contract

不得负责：

价值判断
战略排序
最终选择
transition 执行
Pattern priority

6.2 Action.js

Action.js 是整个 AI 唯一 canonical Action contract。

Action 只保存：

可执行 intent

不得保存 simulation replay control，例如：

restoreActorHand
ignoreCounter

这些只属于 Simulator 局部反事实调用参数。

禁止重新产生：

SearchAction
SimulationAction
EvaluationAction
PatternAction
RootSearchAction
ActionDescriptor

允许保留有真实语义价值的 named Action helper。

禁止为了旧调用方存在而保留无 caller 的 aggregate compatibility facade。

7. Searcher/

7.1 Searcher.js

Searcher 是唯一多步战略搜索编排器。

负责：

root scheduling
root coverage
node expansion
frontier
depth
beam
pruning
SearchBudget invariant
incumbent
TIME / NODE / COMPLETE
fallback search mechanics
hidden-world sampling orchestration
最终 root 选择机械
搜索 diagnostics

Searcher 可以读取 Action identity，用于：

通用搜索机械
稳定 identity
diagnostics
Pattern scheduling hand-off

Searcher 不得定义：

具体卡牌 utility
具体角色 utility
业务 prior
information value
marginal value
resource value
response value

所有“候选好不好”的语义回到 Evaluator。

Searcher 可以内部保留：

lastSequence
bestSequence diagnostics

但这些数据不得成为真实未来执行状态。

7.2 Pattern.js

Pattern.js 是唯一 Pattern / 定式 owner。

负责：

P01–P11 定式定义
Pattern match
continuation
探索顺序建议
战术调度知识

Pattern 可以改变：

先探索谁

不能改变：

最终谁赢

Pattern 不得：

生成非法 Action
直接修改最终 winner
调用 Simulator
调用 Evaluator
调用 Probability
定义 utility
突破 SearchBudget 扩展搜索深度

Pattern 当前与：

Searcher.js
Rng.js

同级。

不存在：

Searcher/Pattern/

子目录。

7.3 Rng.js

Rng.js 是 AI 确定性随机源。

负责：

seed
state
snapshot / restore
deterministic draw
搜索 sampling
搜索调度随机
匿名物理实体 seeded binding

Application / Worker 不得直接新建第二套 AI Rng。

Controller 是 AI runtime Rng 的外部 facade。

8. Event/

8.1 Fact.js

Fact 是唯一确定事实 owner。

负责：

公开事实
AI memory / public knowledge
已知牌
已知装备
已知 condition
公开计数
确定性的玩家 / 规则投影

Fact 不负责概率。

8.2 Probability.js

Probability.js 是唯一 uncertainty facade。

业务代码原则上通过：

Probability.js

查询不确定性。

它协调：

Branch
Pool

负责：

隐藏手牌概率
隐藏资源概率
响应容量概率
finite-pool query
Radar / Lightning / Seal 概率语义
距离 / 装备相关不确定性
probability query / sampling facade

Probability 不构造 canonical World。

Probability 不修改 canonical World。

8.3 Branch.js

Branch.js 负责 generic probability branch algebra：

normalize
merge
marginalize
filter
compatible intersection
compression
clampProbability
cardAvailability

必须保持 generic。

不得拥有：

具体卡牌语义
具体角色语义
Radar 战略
Seal 战略
Lightning 战略
Evaluator utility

8.4 Pool.js

Pool.js 负责 generic finite-pool / without-replacement 数学：

有限池
count
combination
hypergeometric-style query
稀疏 DP
sequence / count probability

Branch 与 Pool 互不依赖：

Branch -X→ Pool
Pool   -X→ Branch

组合统一回到：

Probability.js

9. Simulator/

9.1 Simulator.js

Simulator 是唯一 transition 编排器。

它回答：

对这个显式 canonical World 执行这个 Action / response 后，会得到什么 World？

负责协调：

Damage
Resource
Response
Probability
正式 Domain transition rules

所有 World 都必须显式传入。

Simulator 不拥有：

隐藏 initial World
默认 World

Simulator 可以在 runtime composition 时获得 Evaluator 提供的窄响应 / 局部资源判断能力。

Simulator 不拥有这些判断背后的价值公式。

Simulator 负责构造反事实 / paired / outcome Worlds，例如：

STAY / RESPOND Worlds
Guardian alternatives
Lightning alternatives
root-flip alternatives
resource/action transition alternatives

Probability 提供：

概率 / outcome distribution

Simulator 才负责：

构造 canonical outcome World

9.2 World.js

World.js 是整个 AI 唯一 canonical World contract。

禁止重新出现：

SearchState
SimulationState
EvaluationState
VisibleState
BeliefState
CandidateState
PlanningState

所有 AI 主层统一读取同一个：

World

完整 World deep clone 必须经过 canonical World clone path。

禁止在其它生产代码中直接：

structuredClone(fullWorld)

绕过 clone owner。

9.3 Damage.js

Damage.js 只负责：

damage / HP lifecycle transition

包括：

raw damage
damage modifier
已解析 mitigation 后的伤害
shield
HP loss
heal
fatal
death
kill result

Damage 不拥有：

Guardian 是否响应
Guardian 由谁响应
Guardian 是否值得

它只消费 Simulator 已经编排完成的 mitigation / response result。

9.4 Resource.js

Resource.js 只负责已经确定选择之后的资源 transition：

draw
discard
consume
transfer
energy
equipment
slot
payment
hand/resource mutation

Resource 不负责：

哪张资源战略上更好

合法性：

Generator / Domain

价值：

CardValue / Evaluator

9.5 Response.js

Response.js 只负责 response transition state machine。

负责：

response 顺序
resolved Counter
resolved Block
resolved Guardian
payment / consumption request-result
response termination
branch-specific response application

不负责：

response 价值
response 阈值
hidden response capacity probability
完整战略搜索

分别属于：

Evaluator
Probability
Searcher

Damage / Resource / Response 三个 sibling 禁止互相 import 或互相编排。

跨 sibling 组合统一回到：

Simulator.js

10. Evaluator/

10.1 Evaluator.js

Evaluator 是唯一最终价值与比较 authority。

负责：

StateValue / CardValue 聚合
transition utility
final utility
candidate comparison
response decision
action-specific value
resource value
information value
marginal value
局部公开牌 / 弃牌选择价值

Searcher 消费 Evaluator 的结果。

Controller 只有在：

局部结算
局部小型选择

时可以消费 Evaluator 结果。

Evaluator 不得：

构造 Simulator
apply World
clone World
启动 Searcher
调用 Controller
接收会制造 transition 的 callback
负责合法性

10.2 响应判断一致性

Block、Counter、Guardian、Rescue 分别只能有一套 canonical Evaluator 决策语义。

同一规则同时供：

搜索模拟响应
真实结算响应

使用。

禁止：

搜索模拟使用一个阈值
真实结算使用另一个阈值

搜索 Counter 丢失 Action selection
真实 Counter 又评价具体 selection

所有隐藏 Block branch
统一使用一个“最大 Block 数量”

隐藏概率 branch 必须使用该 branch 自己的事实。

例如：

branch A：1 Block
→ availableBlocks = 1

branch B：2 Blocks
→ availableBlocks = 2

逐 branch 判断。

不得因此产生新的 branch Cartesian genealogy。

10.3 StateValue.js

StateValue 是唯一 non-card World-state valuation primitive owner。

负责：

HP
survival
shield
energy
position / distance
threat
status
alive / dead
team state
seal burden
global board-state consequence

Threat 使用普通 primitive，例如：

threatScore(...)

无实例状态、只有单个 static 方法的 class 不构成独立 abstraction。

StateValue 不直接给：

hand card
equipment asset
resource card

本身计价。

10.4 CardValue.js

CardValue 是唯一 card / equipment / resource valuation primitive owner。

负责：

hand card value
equipment asset value
retention
discard cost
consume cost
draw / acquisition benefit
transfer opportunity cost
resource exchange value
card-role marginal value

CardValue 不选择最终 Action。

StateValue 与 CardValue 互不调用。

最终聚合回到：

Evaluator

同一语义不得两边重复计价。

11. Canonical 数据结构

AI 核心 canonical semantic contract 只保留：

Action
World
Fact
ProbabilityState / Branch / Pool 内部结构
Evaluation result / scalar terms

为了 Worker / runtime 边界，允许存在 data-only transport envelope：

SearchRequest envelope
Worker search outcome envelope
Controller search acceptance / diagnostics record

这些 envelope 必须直接复用 canonical：

Action
World

不能形成另一套模型。

禁止：

SearchAction
ActionDescriptor
RootSearchAction

SearchState
VisibleState
BeliefState
SimulationState
EvaluationState

Candidate DTO
Simulation DTO
Evaluation DTO
future-plan DTO

真实 response 的 DecisionContext 必须：

data-only

可以包含：

canonical World / player data
Simulator 已构造好的 paired/outcome Worlds
普通事实
number
boolean
ID

禁止包含：

Simulator factory
lazy World-construction function
Searcher callback
Controller callback
transition-producing function capability
第二套 player DTO

12. 依赖规则

12.1 主要允许依赖

Controller
 ├→ Generator
 ├→ Searcher
 ├→ Simulator     仅局部结算 / composition
 ├→ Evaluator     仅局部结算 / 局部选择
 ├→ Fact / Probability
 └→ Rng           runtime composition / 匿名绑定

Searcher
 ├→ Generator
 ├→ Pattern
 ├→ Rng
 ├→ Simulator
 ├→ Evaluator
 └→ Probability

Generator
 ├→ Action
 ├→ Fact
 ├→ Probability
 └→ Domain Rules

Simulator
 ├→ World
 ├→ Damage
 ├→ Resource
 ├→ Response
 ├→ Fact
 ├→ Probability
 ├→ Domain Rules
 └→ Evaluator 提供的窄响应判断能力
     （由 Controller 注入；禁止反向依赖）

Evaluator
 ├→ StateValue
 ├→ CardValue
 ├→ Fact
 ├→ Probability
 └→ 价值语义需要的正式 Domain definitions / rules

12.2 禁止的反向 / 越权依赖

Evaluator -X→ Simulator
Evaluator -X→ Searcher
Evaluator -X→ Controller

Pattern   -X→ Simulator
Pattern   -X→ Evaluator
Pattern   -X→ Probability

Generator -X→ Evaluator
Generator -X→ StateValue
Generator -X→ CardValue

Searcher  -X→ Damage
Searcher  -X→ Resource
Searcher  -X→ Response
Searcher  -X→ StateValue
Searcher  -X→ CardValue

Controller -X→ StateValue
Controller -X→ CardValue

Application / Worker
-X→ internal Rng / Pattern / Simulator internal / Evaluator internal

12.3 Internal sibling gate

Branch     -X→ Pool
Pool       -X→ Branch

Damage     -X→ Resource
Damage     -X→ Response
Resource   -X→ Damage
Resource   -X→ Response
Response   -X→ Damage
Response   -X→ Resource

StateValue -X→ CardValue
CardValue  -X→ StateValue

跨 sibling 组合统一返回：

Probability.js
Simulator.js
Evaluator.js

13. 当前完整版架构图

                                  REAL GAME
                                      │
                                      ▼
                                  Controller
                      ┌───────────────┼────────────────┐
                      │               │                │
                      │               │                │
                  完整战略搜索      局部结算响应       物理/runtime绑定
                      │               │                │
                      ▼               │                └──→ Rng
                  Generator           │
                      │               │
               canonical Action[]     │
                      │               │
                      ▼               │
                  Searcher            │
          ┌──────────┼──────────┐     │
          │          │          │     │
          ▼          ▼          ▼     │
       Pattern      Rng      Simulator◄┘
                                │
                    ┌───────────┼───────────┐
                    ▼           ▼           ▼
                 Damage      Resource     Response
                    │           │           │
                    └───────────┼───────────┘
                                ▼
                              World
                                │
                      Searcher 继续编排
                                │
                                ▼
                            Evaluator
                           /         \
                          ▼           ▼
                    StateValue     CardValue
                                │
                                ▼
                         价值 / 比较结果
                                │
                     ┌──────────┴──────────┐
                     │                     │
                     ▼                     ▼
          Searcher 选择当前 root       Controller 完成
               canonical Action         局部结算
                     │                     │
                     └──────────┬──────────┘
                                ▼
                            Controller
                                │
                                ▼
                             REAL GAME
                                │
               每执行一个真实 Action，真实状态改变
                                │
                                └──→ 最新 World
                                     → Generator
                                     → Searcher
                                     → 强制重新搜索


搜索内部响应预测：

Simulator
   └──→ 注入的 Evaluator 响应判断 primitive
          （只允许单向；Evaluator 不调用 Simulator）


基础事实 / 不确定性：

Event
├─ Fact
└─ Probability
   ├─ Branch
   └─ Pool

14. 复杂度 Contract

必须持续满足：

cross-transition probability genealogy = 0

unbounded hidden-identity enumeration = 0

generic persistent Cartesian World expansion = 0

局部 branch combination
= bounded + current-event scoped

完整 World clone
= 只走 canonical clone path

单次 hidden specialization
= 一次 logical deep clone

Controller strategic mini-search
= 0

future Action execution queue
= 0

所有允许存在的局部复杂度必须有明确上界。

例如：

Block branch-specific response
= O(existing branches)

hidden samples
= SearchBudget / config 有界

finite-pool DP
= 有限类别 / 有限数量

response worlds
= 仅当前 response window

性能比较必须固定：

相同 seed
相同 SearchBudget
相同 scenario

至少记录：

root coverage
nodes
simulations
World clones
probability operations
TIME fallback
winner
score

15. Intelligence Contract

必须保留：

合法动作能力
多步搜索能力
Pattern P01–P11
隐藏信息概率推理
响应语义
资源语义
伤害语义
价值知识
RNG 可复现性
Worker / Main parity

“多步搜索能力”的含义：

Searcher 可以评价：

A → B → C

不代表：

真实游戏承诺继续执行 B、C

固定原则：

未来 sequence
用于评价当前 root

真实执行
只提交当前 root

响应一致性：

相同事实
→ 相同 canonical Evaluator 响应判断语义

必须覆盖：

Block
Counter
Guardian
Rescue

16. Public Boundary / Facade Contract

AI 外部生产代码原则上只通过：

Controller

进入 AI。

Controller public responsibility 包括：

selectAction
Search / Worker 执行 facade
局部 response / local-choice facade
匿名物理牌绑定
明确保留的 runtime diagnostics

Application / Worker 不得自己重新 new：

Generator
Searcher
Simulator
Evaluator
Rng
Pattern

整个系统只能有一套 AI composition graph。

17. 历史模块吸收表

本节只记录历史迁移关系。

它不能赋予旧模块当前 authority。

如果历史映射和本文第 1–16 节冲突：

以当前 canonical owner contract 为准

历史模块 / 模块组

最终职责归属

AiController.js

→ Controller.js

policy/AiRuntimePolicy.js

search mechanics → Searcher.js；RNG → Rng.js；runtime boundary → Controller.js

CardSelectionBoundary/Policy

legality → Generator.js；局部 card value → CardValue.js / Evaluator.js；真实绑定 → Controller.js

ResourceSelectionPolicy

legality → Generator.js；transition → Resource.js；value → CardValue.js / Evaluator.js

ResponseBoundary/Policy

runtime boundary → Controller.js；response transition → Response.js；uncertainty → Probability.js；response value → Evaluator.js

TransferPolicy

legality → Generator.js；physical transition → Resource.js；primitive value → CardValue.js；context/final comparison → Evaluator.js

search/Action.js

→ Generator/Action.js

search/ActionGenerator.js

→ Generator/Generator.js

search/Searcher.js

→ Searcher/Searcher.js

SearchRng.js

→ Searcher/Rng.js

PatternMatcher.js / ProductionPatterns.js / scheduling-only SealPrior

→ Searcher/Pattern.js

SearchBudget.js

invariant / mechanics → Searcher.js

SearchPrior.js

search-order mechanics → Searcher.js；value/prior semantic → Evaluator.js

SearchRequest.js / WorkerSearchOutcome.js

data-only transport / boundary → Controller.js

CounterfactualTerms.js

World construction → Simulator.js；value/comparison → Evaluator.js；search orchestration → Searcher.js

TacticResolutionQuery.js

response transition → Response.js；uncertainty → Probability.js；必要 value decision → Evaluator.js

CardEffectSimulation.js / SkillEffectSimulation.js / StatusSimulation.js / CombatSimulation.js

orchestration → Simulator.js；damage → Damage.js；resource → Resource.js；response → Response.js；uncertainty → Probability.js

ResourceValueQuery.js / RootResolutionQuery.js / ValueSimulationQuery.js

transition / counterfactual World → Simulator.js；value → Evaluator.js / value primitives

旧 state/Fact.js

→ Event/Fact.js

旧 Probability 系列

→ Event/Probability/Probability.js / Branch.js / Pool.js

旧 World.js / StateContracts.js

canonical World → Simulator/World.js；真实 Game boundary → Controller.js

RuleProjection.js / distance probability helpers

factual/legal projection → Fact.js / Generator.js；uncertainty → Probability.js；其余删除

value/Evaluator.js

→ Evaluator/Evaluator.js

ThreatValue.js / SealValue.js / state 部分 Economics / GlobalBenefit

→ Evaluator/StateValue.js

CardValue.js / card-resource 部分 Economics / GlobalBenefit

→ Evaluator/CardValue.js

ValueLedger.js

文件删除；diagnostic terms 作为 Evaluator 输出，不形成第二 authority

跨真实 Action 的计划复用机制

删除；bestSequence 只保留搜索证据 / diagnostics

18. 禁止旧架构换名字复活

默认禁止重新创建：

Planner
SearchPolicy
独立 SearchPrior value owner
CandidateMaterializer
TransitionValue
FrontierValue
SiblingTerms

BeliefState
VisibleState
SearchState
SimulationState
EvaluationState

ResponsePolicy
TransferPolicy
SelectionPolicy
ValueSimulationQuery

DecisionService
ResponseService
ValueService
SearchService

Manager / Query / DTO wrapper hierarchy

未来若要新增 internal file，必须同时证明：

独立职责
+
独立 invariant
+
独立测试价值
+
不是 wrapper / DTO / Service / Policy 换皮
+
不会成为新 public authority
+
不会与 sibling 形成循环

文件数量本身不是 KPI。

19. Final Acceptance 门禁

ARCHITECTURE

AI production files = 18

canonical Action = 1
canonical World = 1

static import cycle = 0
runtime authority cycle = 0
duplicate authority = 0

legacy execution path = 0
future-plan execution queue = 0
external internal-facade bypass = 0

SEMANTICS

合法动作能力不丢
模拟规则不丢
概率语义不丢
价值知识不丢
Pattern 知识不丢
响应语义不丢

COMPLEXITY

cross-transition genealogy = 0
unbounded probability expansion = 0
只允许 bounded local N×M
raw full-World clone bypass = 0
不必要 materialization 持续减少

INTELLIGENCE

同 SearchBudget 下决策质量不回归

每个真实 Action 后强制重新战略搜索

Block / Counter / Guardian / Rescue
搜索模拟与真实结算共享同一判断语义

RNG deterministic

Worker / Main semantic parity

CODE QUALITY

dead production wrapper = 0
unused production export = 0
definition-only production function = 0
compatibility facade = 0
stale architecture comment = 0

20. 最终心智模型

以后理解 FiveRealms AI，只需要记下面三条。

正常战略决策

Game
→ Controller
→ Generator
→ Searcher
→ Simulator / Evaluator
→ 一个当前 Action
→ Controller
→ Game
→ 真实状态改变
→ 从头重新搜索

局部结算决策

Game settlement
→ Controller
→ [必要时 Simulator 构造结果 Worlds]
→ Evaluator
→ 局部结果
→ Controller
→ Game settlement

搜索内部

Searcher
→ Generator
→ Simulator
→ 单向使用 Evaluator 响应/value semantic
→ World
→ Evaluator
→ Searcher

最终 owner map：

LEGALITY
→ Generator / Domain Rules

FACT
→ Fact

UNCERTAINTY
→ Probability

TRANSITION
→ Simulator

WORLD
→ World

CARD / RESOURCE VALUE PRIMITIVE
→ CardValue

NON-CARD STATE VALUE PRIMITIVE
→ StateValue

FINAL VALUE / COMPARISON / RESPONSE DECISION
→ Evaluator

MULTI-STEP STRATEGIC SEARCH
→ Searcher

TACTICAL SEARCH SCHEDULING
→ Pattern

AI RANDOMNESS
→ Rng

REAL GAME / WORKER / COMPOSITION / PHYSICAL BINDING
→ Controller

这就是当前冻结后的 FiveRealms AI 最终架构。