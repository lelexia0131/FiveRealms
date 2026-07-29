# 五域纷争

《五域纷争》是一款原创的、纯浏览器运行的单人五人阵营卡牌游戏。真人与四名电脑角色被公开随机分到 2 人和 3 人阵营，选择角色后依次经历摸牌、出牌、即时响应、弃牌与回合交接；消灭敌方全部角色即可获胜。

项目只使用 HTML、CSS、原生 JavaScript、ES Module、JSDoc 与浏览器 API。没有后端、数据库、在线图片、在线音频或运行时第三方依赖。

## 快速启动

在项目根目录执行任一静态服务器命令：

```bash
python -m http.server 8000
```

然后访问：

```text
http://localhost:8000
```

不能直接双击 `index.html`：浏览器通常会阻止 `file://` 页面加载 ES Module。游戏运行不需要 Node.js；`package.json` 只为开发期零依赖测试提供 `npm test` 入口。

## 如何开始一局

1. 在封面点击“开启本局”。
2. 系统立即生成公开的 2V3 阵营，并显示真人本局阵营。
3. 从四名不重复候选角色中选择一名。
4. 四名电脑从剩余角色池中获得不重复角色。
5. 系统洗牌、发牌并随机决定第一个行动角色。
6. 轮到真人时，点击可用手牌；需要目标时，只有发光的合法角色可以点击。
7. 点击“主动技能”可发动角色技能，点击“结束出牌”进入弃牌与回合结束流程。
8. 手牌超过当前生命时，选择准确数量的牌后点击“确认弃牌”。
9. 受到攻击或战术牌影响时，在倒计时内选择响应；超时自动放弃。

## 基本规则

- 五个座位由一名真人和四名电脑组成，阵营公开。
- 晨星与暮影每局随机成为 2 人队或 3 人队；角色背景势力与对局阵营完全独立。
- 同阵营不能成为突袭等敌对牌的目标，援护和辅助技能可以选择队友。
- 生命降到 0 后立即阵亡，不能行动或响应，后续回合会跳过。
- 每回合默认摸 2 张牌、最多使用 1 次突袭和 1 次调息。
- 手牌上限等于当前生命；护盾先于生命承受伤害。
- 每名角色能量上限默认 3，主动技能通常消耗能量。
- 一个阵营没有存活角色时立即结束对局。

## 已实现功能

- 完整封面、角色四选一、桌面对局、日志、响应、弃牌与胜负界面。
- 严格的随机 2V3，真人可能进入任一阵营；二人队每人获得可配置的额外初始牌。
- 八名原创角色，分别拥有事件驱动被动技能和标准接口主动技能。
- 十二种原创卡牌：突袭、格挡、调息、援护、洞察、破势、转移、反制、震荡、夺取、聚能、核心装置。
- Fisher-Yates 洗牌、唯一实体牌 ID、抽牌堆、弃牌堆、结算区、装备区与耗尽重洗。
- 牌在“手牌 → 结算区 → 弃牌堆/装备区”之间明确移动；结算中、手中和装备中的牌不会误入重洗。
- Promise 统一响应系统：格挡、转移、反制、护援；真人有倒计时，电脑有可配置思考延迟。
- 群体伤害逐个目标结算，每个目标独立响应，游戏结束后立即停止后续目标。
- 异步事件总线，可修改伤害、治疗、摸牌与能量上下文，并以唯一监听键避免重复注册。
- AI 行动生成、规则过滤、评分、角色性格修正、随机扰动、响应判断、弃牌策略和独立威胁计算。
- AI 可见状态过滤：其他角色只暴露手牌数量；影客合法窥见的牌只进入其私有记忆。
- 重新征召会清理延迟、倒计时、事件监听、技能监听与未完成交互，并创建全新 `gameId`。
- `debugMode` 集中调试开关和统一 `Debug` 输出工具。

## 当前简化与未实现项

- 不含复杂濒死救援、复活、判定区、距离、座位攻击范围和固定 Boss。
- 反制不能再次被反制；响应栈结构已统一，后续可扩展多层响应。
- 转移第一版只处理明确标记 `canBeRedirected` 的“破势”。
- AI 使用加权启发式而非搜索树；会考虑资源与威胁，但不会推演所有牌序。
- 不保存中途对局，刷新页面会回到封面。
- 界面以常见桌面浏览器为目标，未专门设计窄屏手机布局。

## 项目结构

```text
FiveRealms/
├── index.html                    # 三个主界面与语义化 DOM
├── css/
│   ├── reset.css                 # 浏览器样式归一化
│   ├── layout.css                # 桌面布局和尺寸
│   └── components.css            # 卡牌、角色、日志、响应与动画
├── js/
│   ├── main.js                   # 页面入口与新局控制器
│   ├── config/
│   │   ├── gameConfig.js         # 流程、补偿、速度、AI 与调试参数
│   │   ├── cardConfig.js         # 12 种卡牌公开配置和牌组数量
│   │   └── generalConfig.js      # 8 名角色及 AI 性格
│   ├── core/
│   │   ├── Game.js               # 对局编排、回合、资源、移动与胜负
│   │   ├── Player.js             # 玩家运行时状态
│   │   ├── Deck.js               # 牌堆、弃牌堆、结算区和重洗
│   │   ├── EventBus.js           # 异步可修改事件总线
│   │   ├── ResponseSystem.js     # Promise 统一响应窗口
│   │   ├── RuleEngine.js         # 卡牌和技能合法性
│   │   ├── TeamManager.js        # 2V3 阵营分配
│   │   ├── GeneralSelection.js   # 候选与电脑角色分配
│   │   └── GameLogger.js         # 公开日志唯一入口
│   ├── cards/cardRegistry.js     # 12 种卡牌效果注册表
│   ├── generals/skillRegistry.js # 8 个被动与 8 个主动技能
│   ├── ai/
│   │   ├── AiVisibleState.js     # 隐藏信息过滤
│   │   ├── ThreatCalculator.js   # 独立威胁值
│   │   └── AIController.js       # 行动生成、评分、选择、响应、弃牌
│   ├── ui/UIManager.js           # 渲染、目标、响应和弃牌交互
│   └── utils/                    # 随机、ID、调试和异步清理
├── tests/run.mjs                 # 零依赖核心测试
└── package.json                  # 仅开发测试使用
```

## 角色选择与 2V3 分配

`TeamManager.assignTeams()` 先随机决定哪一个阵营是小队，再将 2 个小队 ID 和 3 个大队 ID 洗牌到五个座位，因此不会通过座位判断阵营。真人固定是控制器座位 0，但 `battleTeam` 同样随机。

角色配置中的 `loreFaction` 是世界观背景，玩家实例中的 `battleTeam` 是本局队伍。所有目标与胜负判断只读取 `battleTeam`。

`GeneralSelection` 先随机取四名候选；确认后，从排除真人角色的池中为电脑分配角色。简单多样性权重会优先补充队伍尚未出现的定位标签。

## 回合流程

每名存活角色依次经历：

1. `turnStart`：重置每回合次数、技能标记，清除在自己下回合开始到期的临时护盾。
2. `beforeStatusResolve / afterStatusResolve`：为持续状态留出统一处理时机。
3. `beforeDraw / afterDraw`：默认摸牌数可被事件修改。
4. `playPhaseStart`：真人等待按钮操作，电脑生成并评分合法行动。
5. `playPhaseEnd`：关闭出牌入口。
6. 弃牌阶段：超出当前生命的手牌必须弃置。
7. `turnEnd`：清理技能持续时间并交给下一名存活角色。
8. 经过本轮首发座位时触发 `roundEnd`，开始下一轮并重置每轮标记。

AI 每个出牌阶段还有 `aiMaxActionsPerTurn` 硬上限，即使未来添加了不消耗资源的动作，也不会无限循环。

## 卡牌结算流程

`Game.playCard()` 是唯一主动用牌入口：

1. `RuleEngine` 检查阶段、次数、资源、手牌归属和目标。
2. 牌从手牌进入 `resolvingCards`，防止快速点击重复使用。
3. 触发 `beforeCardUse` 和 `targetSelected`。
4. 可转移战术牌询问目标是否转移。
5. 触发 `beforeCardResolve`，战术牌依次询问合法反制者。
6. `cardRegistry` 调用伤害、治疗、摸牌、能量或装备等统一 Game 接口。
7. 普通牌进入弃牌堆，核心装置进入唯一装备槽；旧装备进入弃牌堆。
8. 触发 `cardUsed`，让连势、冒险、协调与核心装置等效果监听。

伤害流程是：`beforeDamage` → 状态/技能修正 → 格挡响应 → 护盾 → 生命 → `afterDamage` → 阵亡 → 胜负。UI 从不直接扣血。

## 响应系统

`ResponseSystem` 统一创建以下请求：

- `block`：目标使用格挡，伤害减 1。
- `redirect`：目标使用转移，再通过同一目标选择器选合法新目标。
- `counter`：施牌者的敌人按座位顺序获得反制机会，首个反制取消战术牌。
- `skill`：守誓者选择护援；确认后再选择/评估要弃置的牌。

真人请求由 `UIManager.requestResponse()` 返回 Promise；只有一个 settle 路径，超时和快速多击不能重复结算。电脑请求经 `AIController.shouldRespond()` 评分并等待配置延迟。每个请求完成会从 `pendingResponses` 移除，重新开始会令旧请求和旧 Promise 失效。

## 事件系统

`EventBus` 支持异步顺序执行、可修改事件对象、唯一监听键和递归深度保护。当前流程会触发：

```text
gameStart, teamAssigned, generalSelected, roundStart, turnStart,
beforeStatusResolve, afterStatusResolve, beforeDraw, afterDraw,
playPhaseStart, beforeCardUse, cardUsed, targetSelected,
beforeCardResolve, beforeDamage, afterDamage, beforeHeal, afterHeal,
beforeGainEnergy, afterGainEnergy, beforeCardMove, afterCardMove,
beforePlayerDying, playerDead, playPhaseEnd, turnEnd, roundEnd, gameOver
```

技能监听器使用 `${playerId}:${skillId}` 形式注册。每回合标记保存在 `turnFlags`，每轮标记保存在 `roundFlags`，整局记忆保存在 `gameFlags`/`aiMemory`。这三类状态分别在回合开始、轮开始和新 Game 实例创建时重置。

## AI 评分与隐藏信息

AI 的流程为：

1. `getLegalActions()` 使用与真人相同的 `RuleEngine` 生成卡牌、目标、技能和结束行动。
2. `createAiVisibleState()` 隐藏其他人的手牌内容，只保留数量、公开资源、装备和状态。
3. `ThreatCalculator` 结合低生命击杀价值、手牌数、能量、角色定位、破绽/猎印与近期伤害来源评分。
4. `evaluate()` 结合卡牌效果、目标状态和角色 `aiProfile` 修正。
5. 加入可配置的小幅随机扰动，选择最高分行动。

AI 可以读取自己的完整手牌，因为这是合法信息；它不能通过完整 `GameState` 精确判断敌方格挡或反制。影客的窥隙只把合法看见的 `definitionId` 存入自己的 `aiMemory`，不会自动进入公开日志。

## 常用配置调整

### 修改牌组数量

编辑 `js/config/cardConfig.js` 中各定义的 `count`。`Deck.build()` 自动读取全部定义并生成唯一 ID，不需要修改业务代码。

### 修改初始手牌、摸牌和二人队补偿

编辑 `js/config/gameConfig.js`：

```js
initialHandCount: 4,       // 所有人基础初始牌
smallTeamBonusCards: 1,   // 二人队每人额外牌；设 0 关闭
defaultDrawCount: 2       // 每回合默认摸牌
```

### 修改 AI 速度和难度

```js
aiActionDelayMs: 560,          // 每次电脑行动前等待
aiResponseDelayMs: 420,        // 电脑响应等待
aiDifficultyMultiplier: 1,     // 总体行动评分倍率
enableAiRandomness: true,      // 是否加入扰动
aiRandomnessRange: 0.12        // 扰动范围；越高越不稳定
```

每名角色的 `aiProfile` 位于 `js/config/generalConfig.js`。`aggression`、`defense`、`support`、`healingPriority`、`cardConservation`、`energyConservation`、`responseConservation`、`riskTolerance` 分别控制对应倾向；通常使用 0.4～1.5。

## 添加新卡牌：以“蓄势”为例

目标：使用后获得 1 点能量，并使下一张战术牌效果增强。

1. 在 `js/config/cardConfig.js` 添加公开定义和 `count`：

   ```js
   prepare: Object.freeze({
     definitionId: "prepare",
     name: "蓄势",
     category: "basic",
     categoryName: "能量牌",
     subtypes: ["energy", "buff"],
     description: "获得1点能量，并强化下一张战术牌。",
     targetType: "self",
     responseType: null,
     canBeRedirected: false,
     count: 4,
     aiValue: 5
   })
   ```

2. 在 `js/cards/cardRegistry.js` 的 `CARD_EFFECTS` 注册 `prepare`。调用 `game.gainEnergy()`，并写入 `source.statuses.prepared = { stacks: 1 }`，不要直接改能量上限。
3. 通过 `beforeCardResolve` 事件监听下一张战术牌，修改事件 `metadata` 或牌效果上下文，触发后删除状态。
4. `RuleEngine` 已支持 `self`，如果引入新目标类型，再集中添加分支。
5. 在 `AIController.evaluate()` 为 `prepare` 添加评分，结合当前能量和是否已有蓄势状态。
6. UI 说明自动来自卡牌配置；牌堆也会自动读取 `count`。
7. 在 `tests/run.mjs` 增加注册、状态消耗与能量上限测试。

## 添加新角色：以“铸甲师”为例

目标：最大生命 4；每回合首次装备核心装置后获得 1 护盾；消耗 2 能量把装备交给队友并令其获得 1 护盾。

1. 在 `js/config/generalConfig.js` 添加角色配置，设置 `passiveSkillIds: ["forgeGuard"]`、`activeSkillIds: ["transferCore"]` 和 AI 参数。
2. 在 `js/generals/skillRegistry.js` 的 `PASSIVE_SKILLS` 注册 `forgeGuard`：监听 `afterCardMove`，检查 `event.to === "equipment"`、拥有者和 `owner.turnFlags.forgeGuardUsed`；触发后加护盾并写入回合标记。
3. 在 `ACTIVE_SKILLS` 注册 `transferCore`，提供 `id/name/cost/targetType/canUse/execute`。`canUse` 检查能量、装备、队友和每回合次数。
4. 若现有 `RuleEngine.getSkillTargets()` 没有合适类型，只添加一个通用“存活队友”分支，不要在伤害或回合核心按角色名判断。
5. `execute` 调用 Game 的卡牌移动/装备接口，并通过 `changeEnergy(-2)` 扣能量；不要让 UI 移动装备。
6. 在 `AIController.evaluate()` 为主动技能添加目标价值和能量保留修正。
7. 添加测试：首次装备触发、第二次不触发、回合重置、能量不足、死亡后不触发、旧装备区域正确。

## 添加技能和响应型技能

- 被动技能：在 `PASSIVE_SKILLS` 中监听最接近效果含义的事件，使用含玩家 ID 的唯一 key；先检查 `owner.alive`。
- 主动技能：在 `ACTIVE_SKILLS` 中实现标准对象，由 `Game.useActiveSkill()` 统一执行和加锁。
- 响应型技能：调用 `ResponseSystem.requestSkillResponse()`，让真人与电脑共享请求生命周期；确认后再通过 UI/AI 选择代价或目标。
- 不要在 `Game.damage()`、`takeTurn()` 等核心方法写 `if (player.name === ...)`。

## 添加新状态

瞬时伤害修正优先监听 `beforeDamage`；需要跨回合的状态放在 `player.statuses` 并明确到期条件。临时护盾用“目标下个回合开始”清理；猎印记录来源和到期的追猎者回合编号，避免刚添加就在同回合结束时被清除。

状态的 UI 名称放在 `UIManager.playerTemplate()` 的公开状态映射中。新增状态应测试触发、消耗、到期、来源死亡和重新开始。

## 修改胜负条件

当前唯一入口是 `Game.checkVictory()`：检查晨星和暮影是否仍有存活角色。若增加积分或倒计时胜负，应在这里返回唯一 `winnerTeam`，然后复用已有 `gameOver` 事件、交互取消和遮罩，不要从 UI 直接结束游戏。

## 调试与排错

### 使用调试模式

将 `js/config/gameConfig.js` 的 `debugMode` 改为 `true`。事件注册/触发、牌堆、响应、AI 合法行动和评分会统一通过 `Debug.log()` 输出。关闭后不会产生大量调试输出。

### 排查回合卡住

1. 查看状态栏阶段和当前行动角色。
2. 开启 debug，确认最后一个 `turnStart/playPhaseStart/playPhaseEnd/turnEnd`。
3. 检查是否有未完成 `pendingResponses`，响应面板是否仍在倒计时。
4. 检查真人弃牌数量是否已准确选择。
5. 检查 AI 动作是否能消耗牌、能量或次数；`aiMaxActionsPerTurn` 应阻止无限循环。
6. 重新征召后若旧动作出现，检查新旧 `gameId` 与 `CleanupManager` 返回值。

### 排查重复结算

1. 检查实体牌是否仍在手牌；主动牌必须先进入 `resolvingCards`。
2. 检查 `Game.actionLocked` 是否覆盖目标等待之后的整个结算期。
3. 检查响应 ID 是否仍在 `activeRequestIds`，同一请求只能 `finishRequest()` 一次。
4. 检查技能监听 key 是否包含玩家 ID，避免重复注册。
5. 检查群体牌是否通过 `game.damage()` 逐个 await，而非直接循环扣血。

## 测试

开发期零依赖测试：

```bash
npm test
```

当前自动测试覆盖：

- 300 次阵营分配始终严格 2V3，真人两种阵营均可出现。
- 牌堆总量、唯一 ID、弃牌重洗与结算区隔离。
- 四候选、电脑角色不重复、12 个卡牌结算器和 16 个技能注册完整。
- 突袭只选敌人、满血不能调息、响应牌不能主动使用。
- AI 视图隐藏其他人的具体手牌。
- 护盾先扣、生命后扣，能量不超过上限。
- 主动牌完整经过手牌、结算区和弃牌堆，并对合法敌人结算。
- 使用固定随机种子的五 AI 对局可完整运行到单一阵营获胜。

浏览器验收还会检查：静态服务器启动、模块导入、封面、角色选择、2V3 显示、电脑隐藏手牌、AI 行动、响应窗口、真人可用牌、目标选择、伤害日志与重新征召。

## 后续扩展建议

- 为 ResponseSystem 增加真正的多层响应栈和响应优先级。
- 将卡牌效果拆成更多小文件，同时保留注册表作为唯一入口。
- 增加可注入伪随机数与完整无 UI 自动对局模拟。
- 为事件对象加入 schema 校验和调试时间线导出。
- 扩充持续状态、装备种类和角色池，并保持配置/逻辑分离。
- 在不改变桌面核心信息密度的前提下增加触屏和窄屏布局。
