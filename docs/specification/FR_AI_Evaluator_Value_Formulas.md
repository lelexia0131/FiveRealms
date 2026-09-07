# FiveRealms AI Engine — Evaluator 全价值公式总表

> - `ai/Evaluator/Evaluator.js`
> - `ai/Evaluator/StateValue.js`
> - `ai/Evaluator/CardValue.js`
>
> 本文只描述**当前代码实际存在的公式与比较语义**，不补充不存在的设计。
>
> 为避免把不同层级混在一起，本文把所有公式分为：
>
> 1. **FINAL / State Value**：真正进入候选最终 Utility 的值；
> 2. **Transition Option / END**：最终 Utility 的补充项；
> 3. **Card / Resource Policy Value**：卡牌、资源、转移等局部选择值；
> 4. **Search Prior / Scheduling**：只决定搜索顺序，绝不进入最终 Utility；
> 5. **Response Policy Value**：格挡、反制、救援、护援等响应意愿；
> 6. **Diagnostic Ledger**：只用于诊断归因，不再次计入最终 Utility。

# 0. 记号、单位与总览

## 0.1 两套数值单位

Evaluator 内部首先使用 **State Points（SP）**，最终候选比较使用 **Utility（u）**。

当前唯一换算：

$$
{1u=1HP\_VALUE=5\;SP}
$$

因此：

$$
{u=\frac{SP}{5}}
$$

源码：`StateValue.HP_VALUE`、`StateValue.statePointsToUtility()`。

核心常量：

| **常量当前值含义**         |       |                                                     |
| -------------------------- | ----- | --------------------------------------------------- |
| `HP_VALUE`                 | `5`   | 1 HP = 5 SP = 1u                                    |
| `ENERGY_STATE_WEIGHT`      | `1.2` | 充能桩有效未来增益、END 能量溢出与 X 技能忍耐值的每点 SP |
| `DANGER_VALUE`             | `7`   | Danger 基值；进入 StateValue 时作为 `-7 SP = -1.4u` |
| `DEATH_VALUE`              | `28`  | Death 基值；进入 StateValue 时作为 `-28 SP = -5.6u` |
| `SHIELD_RESERVE_WEIGHT`    | `2`   | 第一层护盾的储备价值                                |
| `SHIELD_PROTECTION_WEIGHT` | `0.5` | 护盾对当前威胁/生命阈值保护的折算系数               |
| `HP3_RISK_WEIGHT`          | `0.2` | HP=3 风险项权重                                     |
| `HP2_RISK_WEIGHT`          | `0.6` | HP=2 风险项权重                                     |
| `RESOURCE_MATERIAL_SCALE`  | `0.4` | card/equipment base material 的唯一 SP 换算 authority |
| `UNKNOWN_HAND_EXPECTED_VALUE` | `5.8` | 无有效 finite-pool 时 unknown base expectation 的唯一 authority |
| `HAND_COUNT_VALUE`         | `1.1` | 每张手牌的数量状态价值                              |

## 0.2 最终候选的最高层公式

当前 Final Transition Utility 的唯一组合公式是：

$$
{ V_{final} = V_{baseTransition} - U(P_{END}) }
$$

其中：

$$
U(x)=\frac{x}{5}
$$

P_{END} 只对 END candidate 非零；普通卡牌/技能动作通常为 0。

源码：`Evaluator.js composeTransitionValue()`。

## 0.3 BaseTransition

$$
{ V_{baseTransition} = V_{stateDelta} + V_{transitionOption} }
$$

其中：

$$
V_{stateDelta} = U\left(V_{state}(Y)-V_{state}(X)\right)
$$

$$
V_{transitionOption} = U(P_{transitionOption})
$$

源码：`Evaluator.js evaluateTransition()`。

## 0.4 牌堆与装备判定基线

标准牌堆由 `RulesetDefinition.deckComposition` 唯一拥有：

| 类别 | 张数 |
| --- | ---: |
| 基础牌 | 92 |
| 战术牌 | 56 |
| 装备牌 | 17 |
| 总计 | 165 |

# 1. 哪些公式真正进入 Final Utility

为了避免把 Search Prior 当作 AI“真实价值”，最终只需沿这条主链看：

```
World X
  ↓
StateValue(X)

Action A
  ↓ Simulator（Evaluator 不构造 World）
World Y
  ↓
StateValue(Y)

ΔState = StateValue(Y) - StateValue(X)
  + TransitionOptionPoints
  ↓ /5
BaseTransition

若 A = END：
  - Energy overflow Pf
  - Legal skill state-value opportunity Ps
  - Forced discard sibling opportunity Pd

= Final Transition Utility
```

数学总式：

$$
{ V_{final}(A) = \frac{V_{state}(Y)-V_{state}(X)+P_{option}}{5} -I[A=END]\frac{P_f+P_s+P_d}{5} }
$$

其中：

$$
{P_f=1.2\max(0,E+G-E_{max})}
$$

$$
{P_s^{normal}=S(E)D'(X)\Delta_s^+}
$$

$$
{P_s^X=1.2-(\Delta_{E+1}-\Delta_E)}
$$

$$
{ P_d = \max_{a\in EligibleSibling} \max(0,\Delta_a-\Delta_{END}) }
$$

其中 `EligibleSibling` 为通过真实 HP / 手牌状态变化减少 END 强制弃牌溢出的完整 sibling。

$$
{ S(E)= \begin{cases} 0,&E<C\\ \sqrt{\frac{E-C+1}{E_{max}-C+1}},&E\ge C \end{cases} }
$$

$$
{D(X)=\max_{i\in allies}R_i}
$$

$$
{D'(X)=\max(0.75,D(X))}
$$

$$
{ R_i=clamp_{[0,1]}\left(\frac{\max(0,-AdverseSafety_i)}{5}\right) }
$$

$$
{\Delta_s^+=\max_{s\in LegalSkill}\max(0,V_{state}(Y_s)-V_{state}(X))}
$$

这就是当前 Evaluator 最终评分 authority 的完整骨架。

# 2. Base Transition

对通过 Transfer competitiveness 门槛的候选：

$$
{ V_{baseTransition} =\frac{\Delta State+P_{option}}{5} }
$$

若根 Transfer 的冻结 preference 分数：

$$
TransferScore<MIN\_TRANSFER\_UTILITY=0.5
$$

则：

$$
V_{baseTransition}=-\infty
$$

# 3. Transition State Delta

给定动作A前后 World：

$$
X\xrightarrow{A}Y
$$

$$
{ \Delta State =V_{state}(Y)-V_{state}(X) }
$$

源码：`Evaluator.js transitionDelta()`。

# 4. State Value 总公式

## 4.1 团队视角 World State Value

设观察者为 `viewer`，玩家 `i` 的阵营符号为：

$$
\sigma_i= \begin{cases} +1,& Team_i=Team_{viewer}\\ -1,& Team_i\ne Team_{viewer} \end{cases}
$$

每个玩家的 material/state value 为：

$$
V_i=Death_i+\sum_k Term_{i,k}
$$

对每个 battleTeam 只计算一次团队共享救援储备 `RescueReserve_t`，则 World 的原始 State Points：

$$
V_{state}(X) = \sum_i\sigma_iV_i + \sum_t\sigma_t RescueReserve_t
- \sum_i SealBurden_i + \sum_l LightningLifecycle_l
$$

注意：`sealTeamBurden()` 本身已经带阵营符号，因此在总 StateValue 中统一执行减法：

- 我方持有封印：`SealBurden > 0` → 减分；
- 敌方持有封印：`SealBurden < 0` → 减去负数，相当于加分。

源码：`Evaluator.js stateValueSnapshot()`；`StateValue.js teamRescueReserve()`。

## 4.2 单玩家 State Value

玩家死亡时：

$$
{V_i=-28\;SP}
$$

且不再加入活人 terms。

玩家存活时：

$$
\begin{aligned} V_i={}& HPValue\\ &+Danger\\ &+ExposeStackValue\\ &+MarkThreat\\ &+ResidualExposureValue\\ &+RadarFutureUtility\\ &+HP3Risk\\ &+HP2Risk\\ &+ShieldValue\\ &+BubbleMachineFuture\\ &+EnergyDeviceFuture\\ &+BattleDeviceFuture\\ &+RecycleDeviceFuture\\ &+AssaultMagazineFuture\\ &+HandCountValue\\ &+HandRoleDelta\\ &+EquipmentBaseMaterial\\ &+EquipmentRoleDelta \end{aligned}
$$

其中前半由 `StateValue.js` 唯一拥有，手牌/装备 intrinsic asset 由 `CardValue.js` 唯一拥有。

源码：`StateValue.js statePlayerValueTerms()`；`CardValue.js cardPlayerValueTerms()`；`Evaluator.js playerValueTerms()`。

# 5. 单玩家 StateValue 各项详细公式

## 5.1 HP

$$
{HPValue=HP\times5}
$$

所以：

$$
1HP=5SP=1u
$$

## 5.2 Danger

若玩家存活且：

$$
HP\le1
$$

则：

$$
{Danger=-7SP=-1.4u}
$$

否则：

$$
Danger=0
$$

## 5.3 团队 Rescue Reserve

本项不属于任何单玩家 `V_i`，而是每个 battleTeam 在 State Value 中只计算一次。
只统计该阵营存活成员。成员需求为：

$$
N_i=\begin{cases}
1,&HP_i\le1\\
0.5+0.5T_i,&HP_i=2\\
0,&HP_i\ge3
\end{cases}
$$

HP=2 的威胁必须复用同一次 State Value 遍历已经得到的 `HP2Risk`：

$$
T_i=\min(1,ThreatDamage_i)=
\frac{-HP2Risk_i}{DANGER\_VALUE\times HP2\_RISK\_WEIGHT}
$$

团队总需求与合法调息期望容量：

$$
D=\sum_{i\in Team,\ i\ne viewer}N_i
$$

$$
C=\sum_{i\in Team}RecoveryCapacity_i
$$

有效容量：

$$
C_e=\min(C,D)
$$

最终团队共享状态值：

$$
{RescueReserve=\begin{cases}
0,&D\le0\lor C\le0\\[4pt]
\dfrac{8DC_e}{D+C_e},&otherwise
\end{cases}}
$$

同一张调息只属于一份团队容量；超过需求的调息不继续获得本项价值。

## 5.4 破势层 `Expose Weakness Stacks`

$$
{ExposeStackValue=Stacks\times3}\ (Stacks代表层数)
$$

即：

$$
1ExposeStackValue=3SP=0.6u
$$

## 5.5 Hunt Mark 威胁

猎杀标记概率质量，其中 P 表示玩家 i 被标记上猎印的概率：

$$
MarkMass = \sum_{i\in Players} P_i(mark)
$$

最终：

$$
{MarkThreat=-2\times MarkMass}
$$

故身上携带猎印等效-0.4u

例如：当场上 1 名玩家已经被标记上猎印，1名玩家60%的概率被标记上猎印时，

$$
MarkThreat=-2\times(1+0.6)=-3.2SP=-0.64u
$$

# 6. Exposure 原始暴露度公式

源码：`StateValue.assaultRangeAllocation()`、`StateValue.exposureComponents()`。

## 6.1 联合距离世界中的边际可达率与突袭分配质量

对敌人 `e` 的全部存活敌对目标，在 `getRangeConditionBranches()` 返回的共享距离世界中：

目标 `t` 的边际可达概率：

$$
RangeProbability_{e,t} = \sum_{w:t\;reachable\;in\;w}P(w)
$$

该目标的突袭分配质量：

$$
AssaultAllocation_{e,t} = \sum_{w:t\;reachable} \frac{P(w)}{ReachableTargetCount_w}
$$

因此一张突袭不会在多个目标上重复计全额。

例如敌人e有1张突袭库存，一共 3 个概率世界w_1（A,B,C均可达），w_2（只有A，B可达），w_3（只有A可达），其中

$$
P(w_1)=0.3\ P(w_2)=0.5\ P(w_3)=0.2
$$

那么有：

$$
AssaultAllocation_{e,A}=\frac{0.3}{3}+\frac{0.5}{2}+\frac{0.2}{1}=0.55
$$

$$
AssaultAllocation_{e,B}=\frac{0.3}{3}+\frac{0.5}{2}=0.35
$$

$$
AssaultAllocation_{e,C}=\frac{0.3}{3}=0.10
$$

## 6.2 当前突袭威胁

Event/Probability 提供：

- `P_assault`：目标敌人至少持有突袭的概率；
- `E_assault`：突袭期望数量。

当前威胁：

$$
{ CurrentThreat = P_{assault}\times HP\_VALUE\times AssaultAllocation }
$$

## 6.3 未来突袭库存

为了避免同一第一张突袭同时计入“当前威胁”和“未来库存”：

$$
FutureCount = \min\left(3,\max(0,E_{assault}-P_{assault})\right)
$$

然后：

$$
{ FutureInventory = FutureCount\times0.5\times5\times AssaultAllocation }
$$

## 6.4 敌方能量压力

$$
{ EnergyPressure = \min(2,EnemyEnergy)\times0.3\times5\times RangeProbability }
$$

## 6.5 原始暴露度

$$
{ Exposure = CurrentThreat+FutureInventory+EnergyPressure }
$$

StateValue 中三项均以负值进入玩家价值：

$$
-currentThreat, \quad -futureInventory, \quad -energyPressure
$$

# 7. Radar / Low-HP Risk / Shield

## 7.1 防御装置 Radar 减免与 Future Utility

源码：`StateValue.radarMitigationUtility()`、`StateValue.expectedBlockDemand()`、`StateValue.radarFutureUtility()`、`Evaluator.radarJudgmentValueInputs()`。

仅 `equipmentDefinitionId == defenseDevice`：

$$
RadarMitigation = Exposure\times Retention\times P_{tacticJudgment}
$$

否则为 0。其中 `Retention` 表示雷达存在概率，`P_tacticJudgment `表示判定命中概率，均是`Event`已知

剩余暴露度ResidualExposure（即原始暴露度减去雷达减免值）：

$$
ResidualExposure=\max(0,Exposure-RadarMitigation)
$$

`P_tacticJudgment` 来自 Event/Probability 的雷达判定池。

进入玩家 StateValue 的剩余暴露价值：  
$$
ResidualExposureValue=-ResidualExposure
$$
即：  
$$
ResidualExposureValue=-\max(0,Exposure-RadarMitigation)
$$
该 exposure 风险减免之外，Radar 还拥有独立的真实判定资源 Future Utility。它只在存在真实 Block demand 时产生：

$$
RadarFutureUtility=ExpectedBlockDemand\times Retention\times ExpectedUtilityPerJudgment 
$$

其中：
$$
ExpectedUtilityPerJudgment=P(Tactic)\times AvoidedBlockDemandValue+\sum_{d\in Basic}P(d)\times BasicHandValue(d)
$$

一次战术牌判定免除对应的一次 Block demand，其价值等于避免支付一张已有 Block 的真实 Hand StateValue。`Block` 属于正常 Basic；Radar 判得任一基础牌时，首先按统一 hand value authority 计入：

$$
BasicHandValue(d)=HAND\_COUNT\_VALUE+I[holder=viewer]\times RoleDelta(holder,d)
$$

其中 RoleDelta 不乘材料尺度；`holder != viewer` 时该项为 0。判得 Block 后是否用于当前防御，由 Simulator / Response 的真实 Block payment 决定；Future 不提前排除或假设消费。判得 Block 并留下时保留正常 `BasicHandValue`，立即消费时则由支付后的 StateDelta 自然扣除。`AvoidedBlockDemandValue` 也使用同一真实手牌公式对现有 `block` 计算，不建立 Block 专属价值体系。

`ExpectedBlockDemand` 由 `StateValue.expectedBlockDemand()` 从真实 production source 汇总：

$$
\begin{aligned}
ExpectedBlockDemand={}&ExpectedUsableAssaults\times AssaultAllocation\times DeviceAttackRequirement\\
&+E[ShockwaveCount]\times DeviceAttackRequirement\\
&+P(BurningFieldReady)\\
&+P(HuntReady)\times P(HuntMarkPresent)
\end{aligned}
$$

其中：

$$
DeviceAttackRequirement=NormalRequirement+\\BattleDeviceRetention\times(BattleRequirement-NormalRequirement)
$$

`NormalRequirement` 与 `BattleRequirement` 均读取 Domain `getRequiredBlockCount()`；军火库双需求因此自然产生两次独立 Radar judgment opportunity。普通 Assault、Shockwave、Burning Field 与 Hunt/hunt-mark 都按真实规则进入，不存在 `if radar then +X` 特判。

判定类别与每个基础牌定义的概率全部来自 Event/Probability 的 `buildRadarJudgmentProbabilities()` 和当前 remaining finite pool；Evaluator/StateValue 不建立第二套概率系统。Radar 的 Base Card Value 为 9，其 base material 与上述功能 Future Utility 分开记账。

## 7.2 低血量风险与附加剩余暴露度

HP=3 与 HP=2 风险共用同一套附加暴露数据链：
`defensiveStateValue()` 与完整玩家 StateValue 都复用 `lowHpThreatRiskTerms()`，一次取得互斥的 `hp3Risk` 与 `hp2Risk`。

$$
BufferExposure=\sum_{enemy,\ enemy\ne viewer}Exposure_{enemy\rightarrow player}
$$

$$
BufferRadarMitigation=BufferExposure\times Retention \times P_{tacticJudgment}
$$

那么附加剩余暴露度为：

$$
BufferResidualExposure=max(0,BufferExposure-BufferRadarMitigation)
$$

$$
ThreatDamage = \frac{BufferResidualExposure}{5}
$$

$$
{ HP3Risk = -\min(1,ThreatDamage)\times DANGER\_VALUE\times HP3\_RISK\_WEIGHT }
$$

仅 HP=3 生效，`DANGER_VALUE=7`、`HP3_RISK_WEIGHT=0.2`，最大负值：

$$
-1.4SP=-0.28u
$$

$$
{ HP2Risk = -\min(1,ThreatDamage)\times DANGER\_VALUE\times HP2\_RISK\_WEIGHT }
$$

仅 HP=2 生效，`DANGER_VALUE=7`、`HP2_RISK_WEIGHT=0.6`，最大负值：

$$
-4.2SP=-0.84u
$$

## 7.3 护盾价值

护盾数量：

$$
S_h=\max(0,shield)
$$

第一层储备价值：

$$
Reserve=2\times\min(S_h,1)
$$

残余威胁折成 HP：

$$
ThreatPoints=\frac{ResidualExposure}{5}
$$

可吸收数量：

$$
Absorbed=\min(S_h,ThreatPoints)
$$

普通 HP 保护：

$$
HPProtection =Absorbed\times5
$$

生命阈值 premium：

$$
LifePremium= \begin{cases} 28-5=23,&HP=1\\ 7-5=2,&HP=2\\ 0,&otherwise \end{cases}
$$

阈值保护：

$$
LifeProtection =\min(1,Absorbed)\times LifePremium\times0.5
$$

0.5 是因为 `SHIELD_PROTECTION_WEIGHT`

总护盾价值：

$$
{ ShieldValue=Reserve+HPProtection+LifeProtection }
$$

## 7.4 泡泡机未来护盾价值

`BubbleMachineFuture` 只表示当前装备泡泡机且当前护盾为 0 时，下一次自己的回合开始尚未兑现的第一层普通护盾状态价值。它直接复用上一节的 `ShieldValue` authority：
$$
BubbleMachineFuture=
I(alive)\times I(equipment=bubbleMachine)\times I(Shield=0)\times \\R_{equipment}
\times[ShieldValue(1)-ShieldValue(0)]
$$

其中 `R_equipment` 直接使用现有 `equipmentRetentionProbability`，并且只在本项乘一次；当前没有额外的公共 equipment-future retention 管线，因此不得再做第二次折损。该公式不引入泡泡机专属价值常数，也不复制 `Reserve`、`HPProtection` 或 `LifeProtection`。

当前已有护盾时：

$$
Shield>0\Rightarrow BubbleMachineFuture=0
$$

触发前真实 `ShieldValue` 按 0 盾计算，而 `BubbleMachineFuture` 表示尚未兑现的第一层；真实 `turnStart` 形成 1 点护盾后，`BubbleMachineFuture` 归零，新增价值切换到现有 `ShieldValue`，两者不重复计价。该快照 Future 不预测下一回合前的攻击、护盾消耗或专属触发概率，也不包含静态装备价值 7 与角色差量。

# 8. 充能桩未来能量价值

源码：`StateValue.js energyDeviceFutureUtility()`。

仅持有 `energyDevice` 时。

设：

- `Cap` = `getMaxEnergy()`；
- `E` = 当前能量；
- `G0` = 无装备时 `baseAmount + teamBonus`；
- `G1` = 有充能桩时 `baseAmount + teamBonus + equipmentBonus`；
- `R` = 装备保留概率。

则：

$$
E_0=\min(Cap,E+G_0)
$$

$$
E_1=\min(Cap,E+G_1)
$$

$$
EffectiveGain=\max(0,E_1-E_0)
$$

$$
{ EnergyDeviceFuture =R\times EffectiveGain\times1.2 }
$$

其中 1.2 是 `ENERGY_STATE_WEIGHT`

这避免把已经超过能量上限的未来能量继续计价。

# 9. Card / Equipment Asset State Value

源码：`CardValue.cardPlayerValueTerms()`。

## 9.1 手牌数量

$$
{HandCountValue=HandCount\times1.1}
$$

因此每张纯数量手牌价值为：

$$
1.1SP=0.22u
$$

## 9.2 Viewer 自己手牌的角色差量

只有 `player.id == viewerId` 才读取具体合法手牌身份：

$$
{ HandRoleDelta = \sum_{card\in hand} RoleDelta(character,card)\times Availability(card) }
$$

其中：

$$
RoleDelta=RoleCardValue-BaseCardValue
$$

`Availability(card)` 就是这张牌在当前概率状态下“实际存在/可用”的概率权重，属于 `Event/Probability` 提供的概率信息，敌方/队友未知具体手牌不会凭空添加 `HandRole`。

## 9.3 装备 intrinsic asset

基础装备价值：

$$
B_e=BaseCardAIValue(equipment)
$$

装备保留概率：

$$
R_e=EquipmentRetentionProbability
$$

材料尺度：

$$
RESOURCE\_MATERIAL\_SCALE=0.4
$$

装备基础资产：

$$
 EquipmentBaseMaterial=B_e\times R_e\times RESOURCE\_MATERIAL\_SCALE 
$$

角色装备差量与 BaseAiValue 共同组成装备静态资产，并使用同一材料尺度：

$$
 EquipmentRoleDelta=RoleDelta(character,equipment)\times R_e\times RESOURCE\_MATERIAL\_SCALE 
$$

因此也可统一写为：

$$
EquipmentStaticAsset=(BaseAiValue+RoleDelta)\times R_e\times RESOURCE\_MATERIAL\_SCALE
$$

## 9.4 通用 Block 防御成本

源码：`StateValue.expectedDefenseCost()`、`StateValue.expectedDamageStateLoss()`。

单张 Block 的实际手牌 StateValue 由 CardValue authority 组成：

$$
BlockSpendValue(holder,viewer)=HAND\_COUNT\_VALUE+I[holder=viewer]\times RoleDelta(holder,block)
$$

普通手牌不持有 Base material，且只有 viewer 自己的合法已知 Block 才包含未缩放 RoleDelta。

设目标当前 Block 数量分布为 $P(N=n)$，真实 Domain demand 为 $r$，一次未格挡伤害造成的现有生命、Danger、低血量 Risk 与 ShieldValue 边际为 $DamageStateLoss$。没有 Radar 时：

$$
{DefenseCost(r)=\sum_nP(N=n)\begin{cases}r\times BlockSpendValue,&n\ge r\\DamageStateLoss,&n<r\end{cases}}
$$

该分段严格保留真实规则：数量不足时不浪费 Block。$DamageStateLoss$ 复用现有生命/危险/护盾 authority，不等同于固定 `HP_VALUE`。

目标持有 Radar 时，每个 demand 复用 `buildRadarJudgmentSequenceProbabilities()` 的无放回顺序结果。设一次 sequence 免除 $w$ 个 demand、判得 $b$ 张 Block：

$$
DefenseCost_{radar}(r)=\sum_sP(s)\times
\begin{cases}
\max(0,r-w_s-b_s)\times BlockSpendValue,&N+b_s\ge r-w_s\\
DamageStateLoss,&N+b_s<r-w_s
\end{cases}
$$

最终按 Radar retention 混合有/无装备世界。战术判定只免除对应 demand；判得 Block 可参与同次防御，其获得会抵消同次支付中的等量 HandState loss。全部基础牌判定的 hand value 仍由 `RadarFutureUtility` 统一拥有，不进入攻击方的 `DefenseCost`。

## 9.5 军火库 Future Utility

源码：`StateValue.expectedDeviceAttackCount()`、`battleDeviceFutureUtility()`。

受军火库影响的攻击来源不在 Evaluator 按名称列举，而是从正式 CardDefinitions 派生：拥有 `assault` subtype、正伤害字段，且目标语义为单目标距离攻击或全体敌人的定义。单目标库存复用 `expectedUsableAssaultsNextTurn()` 与共享距离世界分配；全体攻击复用当前 `queryPlayerHandProbability()` inventory。

普通与军火库需求都读取 Domain `getRequiredBlockCount()`：

$$
r_0=getRequiredBlockCount(null,true)
$$

$$
r_B=getRequiredBlockCount(battleDevice,true)
$$

因此：

$$
BattleDeviceFuture=R_B\sum_tExpectedDeviceAttacks(holder,t)\times[DefenseCost_t(r_B)-DefenseCost_t(r_0)]
$$

这自然给出：0 Block 时两个需求通常都命中，边际接近 0；恰 1 Block 时从可挡变为命中；2+ Block 时多支付一张 Block。装备 retention 只在本式乘一次；目标 Radar 增加的判定摸牌收益留在目标自身 `RadarFutureUtility`，不在军火库方重复加入。

## 9.6 回收站 Future Utility

源码：`StateValue.expectedActiveTacticCount()`、`expectedResponseTacticCount()`、`recycleDeviceFutureUtility()`、`Evaluator.expectedDrawGainValue()`。

剩余额度严格读取 Definition：

$$
RemainingUses=\max(0,MaxUsesPerTurn-recycleDeviceUses)
$$

主动战术逐定义通过 Domain `canPlayCard()` 检查未来正常 play phase 的真实合法性，再用 `queryPlayerHandProbability()` 读取 known/finite-pool 数量。响应型战术库存只与其他存活玩家当前合法且可反制的主动战术机会配对；响应链必须由主动战术作为根，不能凭空递归 Counter-against-Counter。

$$
ExpectedUsableTactics=ExpectedLegalActiveTactics+\min(ExpectedResponseTactics,ExpectedCounterableOpportunities)
$$

$$
ExpectedTriggerCount=\min(RemainingUses,ExpectedUsableTactics)
$$

回收站通过 `gainUnknownCardsWithCounterState()` 获得匿名牌，不产生合法已知 definition，因此每次摸牌只兑现 HandCount：

$$
ExpectedDrawGain=HAND\_COUNT\_VALUE
$$

该 Future 不读取 finite-pool Base expectation，也不使用 `UNKNOWN_HAND_EXPECTED_VALUE`。最终：

$$
RecycleDeviceFuture=R_R\times ExpectedTriggerCount\times TriggerDrawCount\times ExpectedDrawGain
$$

本式只估计当前 World 已拥有或概率拥有的战术，不把预计摸到的新牌递归成下一次触发。Simulator 已实际触发后，handCount 增加且 `recycleDeviceUses` 同步增加，因此已兑现手牌价值与剩余 Future 自然一升一降。

## 9.7 备用弹夹 Future Utility

源码：`StateValue.assaultInventoryOpportunityValue()`、`assaultMagazineFutureUtility()`、`expectedUsableAssaultsNextTurn()`。

对同一个 World 构造只移除备用弹夹效果的配对玩家。每个世界的可兑现突袭数都直接复用 `expectedUsableAssaultsNextTurn()`；该 primitive 已包含 inventory、Domain 有效 attack limit、装备 retention 与破军合法额外容量。

$$
AssaultInventoryOpportunityValue(p)=ExpectedUsableAssaults(p)\times\sum_tAssaultAllocation(p,t)\times DefenseCost_t(r_0)
$$

其中 `AssaultAllocation` 来自共享距离条件世界，`DefenseCost` 包含 Block 分布、Radar 无放回判定、Shield 与 survivability 边际。

$$
AssaultMagazineFuture=\max(0,OpportunityValue(withMagazine)-OpportunityValue(withoutMagazine))
$$

只有 1 张 Assault 时两世界均只能兑现 1 次，Future 为 0；库存超过基础上限时才出现正边际。retention 已在 `expectedUsableAssaultsNextTurn(withMagazine)` 内混合，外层不得再次相乘。

# 10. 静态卡牌价值常量

`CARD_AI_VALUES` 是唯一 Base Card Value authority；`CARD_DEFINITIONS` 不保存 `aiValue`。

这些值主要服务保留、资源、搜索 prior；**不直接作为 Final Transition Value**。

| **CardBase AI Value** |      |
| --------------------- | ---- |
| assault 突袭          | 4    |
| recover 调息          | 6    |
| block 格挡            | 5    |
| charge 聚能           | 5    |
| shield 护盾           | 7    |
| scout 窥探            | 5    |
| transfer 转移         | 7    |
| exposeWeakness 破势   | 6    |
| shockwave 震荡        | 8    |
| provoke 挑衅          | 8    |
| leverage 借势         | 7    |
| plunder 掠夺          | 7    |
| destroy 破坏          | 6    |
| counter 反制          | 8    |
| harvest 丰收          | 8    |
| duel  决斗            | 6    |
| mutualBenefit 互利    | 6    |
| symbiosis 共生        | 5    |
| seal 封印             | 7    |
| lightning 闪电        | 3    |
| energyDevice 充能桩   | 7    |
| recycleDevice 回收站  | 8    |
| bubbleMachine 泡泡机  | 7    |
| defenseDevice 雷达    | 9    |
| battleDevice 军火库   | 9    |
| assaultMagazine 备用弹夹 | 8 |
| telescope 望远镜      | 8    |
| barrierDevice 屏障    | 9    |

# 11. 角色 × 卡牌静态差量

$$
{ RoleCardValue(character,card) = BaseCardValue(card)+RoleDelta(character,card) }
$$

未列出的组合：

$$
RoleDelta=0
$$

差量合法范围被冻结为整数 `[-2,2]`。

当前稀疏差量：

| **卡牌刃行者守誓者灵医影客炎术师追猎者赌命者调律师** |      |      |      |      |      |      |      |      |
| ---------------------------------------------------- | ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- |
| 突袭                                                 | +2   | -1   | -1   | 0    | 0    | +2   | +1   | -1   |
| 调息                                                 | 0    | +1   | +2   | +1   | +1   | 0    | 0    | 0    |
| 格挡                                                 | -1   | +1   | +1   | +1   | +1   | -1   | -1   | +1   |
| 聚能                                                 | -1   | 0    | +2   | +2   | +1   | +1   | +1   | +2   |
| 护盾                                                 | 0    | +1   | +1   | 0    | 0    | 0    | 0    | +1   |
| 窥探                                                 | +1   | 0    | 0    | -1   | -2   | -1   | 0    | +1   |
| 转移                                                 | 0    | +1   | +1   | 0    | -1   | 0    | -1   | +2   |
| 破势                                                 | +1   | -1   | -1   | +1   | 0    | +1   | +1   | -1   |
| 震荡                                                 | +1   | -1   | -1   | 0    | +1   | 0    | +1   | 0    |
| 挑衅                                                 | +1   | -1   | -1   | 0    | +1   | 0    | +1   | 0    |
| 借势                                                 | +1   | 0    | 0    | 0    | 0    | +1   | 0    | +2   |
| 掠夺                                                 | +1   | +1   | -1   | 0    | 0    | +1   | +1   | +2   |
| 破坏                                                 | +1   | 0    | 0    | -1   | 0    | +1   | 0    | +1   |
| 反制                                                 | 0    | +1   | +1   | 0    | -1   | -1   | -1   | +2   |
| 丰收                                                 | 0    | +1   | +1   | 0    | 0    | 0    | +1   | +1   |
| 决斗                                                 | -1   | -1   | -1   | +1   | 0    | 0    | +1   | -1   |
| 互利                                                 | 0    | -1   | 0    | 0    | 0    | 0    | +1   | +2   |
| 共生                                                 | -1   | +1   | +2   | 0    | -1   | -1   | -1   | +1   |
| 封印                                                 | 0    | 0    | 0    | -1   | +1   | +1   | 0    | -1   |
| 充能桩                                               | -1   | 0    | +1   | +1   | +1   | +1   | +1   | 0    |
| 回收站                                               | 0    | -1   | -1   | 0    | +1   | -1   | +1   | +1   |
| 泡泡机                                               | 0    | +2   | -1   | +1   | 0    | 0    | 0    | +1   |
| 雷达                                                 | -1   | +1   | +1   | 0    | 0    | -1   | -1   | +1   |
| 军火库                                               | +2   | -1   | -1   | +1   | 0    | +1   | +1   | -1   |
| 备用弹夹                                             | +2   | 0    | 0    | 0    | +1   | +2   | +1   | 0    |
| 望远镜                                               | +1   | -1   | -1   | +1   | 0    | +1   | 0    | +1   |
| 屏障                                                 | -1   | +1   | +1   | 0    | 0    | -1   | -1   | +1   |

# 12. 技能准备、攻击库存与封印机会价值

这一组主要用于 **Seal burden / Search Prior / Policy**；其中 `turnOpportunityValue()` 会通过 `sealTeamBurden()` 进入正式 State Value。

## 12.1 下一回合技能可用概率

Event/Domain 已提供当前能量、回合增益、装备保留概率、技能费用和次数上限。

把下一回合可能能量分支记为：

$$
\{(p_j,E_j)\}
$$

则：

$$
{ P_{skillReady} = clamp\left(\sum_{j:E_j\ge C}p_j\right) }
$$

若没有主动技能、费用≤0、次数上限≤0，则为 0。

## 12.2 技能准备威胁

$$
{ SkillReadinessThreat =P_{skillReady}\times\left(3+0.5\cdot I[E\ge C]\right) }
$$

该值只用于策略威胁尺度，不进入真实技能效果价值。

## 12.3 下一回合可兑现突袭数

当前主动突袭有效上限为：

$$
L_{effective}=L_{team}+L_{equipment}+L_{temporary}
$$

备用弹夹装备在装备槽时：

$$
L_{equipment}=2
$$

未装备时：

$$
L_{equipment}=0
$$

下一回合估值中，令突袭库存为 `A`，阵营基础主动突袭次数为 `L`，备用弹夹保留概率为 `r`。

破军额外一次容量概率：

$$
p= \begin{cases} P_{skillReady},&activeSkill=breakArmy\\ 0,&otherwise \end{cases}
$$

先定义没有备用弹夹时的兑现函数：

$$
g(A,L,p)=\min(A,L)+p\cdot\min(1,\max(0,A-L))
$$

备用弹夹保留分支的兑现量为：

$$
U(A)=(1-r)g(A,L,p)+r\,g(A,L+2,p)
$$

若突袭库存为概率分布：

$$
E[U]=\sum_aP(A=a)\left[(1-r)g(a,L,p)+r\,g(a,L+2,p)\right]
$$

等价地，可写为：

$$
{U=E_{A,R,B}[\min(A,L+2R+B)]}
$$

其中 $R\sim Bernoulli(r)$，$B\sim Bernoulli(p)$。Event 分布若存在会先按实际总质量归一化；否则使用库存期望值代入同一函数。

## 12.4 突袭威胁

$$
Reserve=\max(0,E[A]-E[U])
$$

$$
{ V_{assault}=1.25E[U]+0.25\min(2,\max(0,E[A]-E[U])) }
$$

## 12.5 角色属性威胁

设攻击类 role tag 数量：

$$
TagCount=\#\{damage,attacker,caster,hunter\}
$$

$$
Resources=\min(3,E[UsableAssaultsNextTurn])
$$

$$
{ RoleThreatSynergy =Resources\times\min(0.75,0.3\times TagCount) }
$$

无攻击资源则为 0。

## 12.6 攻击性装备牌威胁

仅攻击型装备：

$$
{ EquipmentThreatSynergy =Resources\times0.75\times Retention }
$$

备用弹夹的 subtype 为 `assault-capacity`，不属于本节的 `attack` 装备集合；它的收益只通过有效次数上限进入 `expectedUsableAssaultsNextTurn()` 与 `AssaultThreat`。

## 12.7 回合机会价值

手牌数 `H`、能量 `E`：

$$
CharacterResources =\min(2.5,0.25H+0.35E)
$$

$$
\begin{aligned} TurnOpportunityValue={}6 &+CharacterResources\\ &+SkillReadinessThreat\\ &+AssaultThreat\\ &+RoleThreatSynergy\\ &+EquipmentThreatSynergy\\ \end{aligned}
$$

这表示“被封印跳过一次出牌阶段”损失的机会价值。

# 13. 封印状态负担惩罚

`sealOutcomeProbabilities()` 来自 Event，提供：

$$
P_{skip}=P(skipAction)
$$

阵营符号：

$$
Sign= \begin{cases} +1,&holder\;ally\\ -1,&holder\;enemy \end{cases}
$$

$$
{ SealTeamBurden =P_{skip}\times TurnOpportunityValue\times Sign }
$$

World State Value 中执行：

$$
V_{state}\;-=SealTeamBurden
$$

源码：`StateValue.js`。

# 14. 团队危险性

## 14.1 Danger term 集合

`TEAM_DANGER_TERM_KEYS`：

```
Danger
HP3Risk
HP2Risk
ShieldValue
MarkThreat
ResidualExposureValue
```

明确不包括：

```
HandCountValue
HandRoleDelta
EquipmentValue
EquipmentRoleDelta
ExposeStackValue
EnergyDeviceFuture
BubbleMachineFuture
BattleDeviceFuture
RecycleDeviceFuture
AssaultMagazineFuture
```

## 14.2 单玩家风险度 R_i

$$
AdverseProjection_i =Death_i+\sum_{k\in DangerKeys}Term_{i,k}
$$

$$
DangerPoints_i =\max(0,-AdverseProjection_i)
$$

然后用唯一 HP-equivalent 换算并夹到 `[0,1]`：

$$
{ R_i =clamp_{[0,1]}\left(\frac{DangerPoints_i}{5}\right) }
$$

## 14.3 团队危险度 D(X)

$$
{ D(X)=\max_{i\in allies}R_i }
$$

因此只要任一己方角色处于高风险，团队危险度不会被其它安全队友平均稀释。

END 的普通技能机会损失使用最低危险系数：

$$
{ D'(X)=\max(0.75,D(X)) }
$$

# 15. Lightning 生命周期价值

## 15.1 单 owner 期望材料变化

对一枚闪电 outcome set：

- `Presence` = 闪电状态存在概率；
- outcome `j` 有概率 `p_j`；
- `ΔMaterial_{owner,j}` = 对 owner 的前后 material value 差。

$$
{ \Delta Owner =\sum_j Presence\times p_j\times\Delta Material_j }
$$

## 15.2 Viewer 阵营 Lightning Lifecycle Value

$$
{ LightningLifecycle =\sum_i\sigma_i\Delta Owner_i }
$$

它以 State Points 进入 World State Value。

## 15.3 Lightning Burden

$$
{ LightningTeamBurden=-LightningLifecycle }
$$

## 15.4 Lightning Counter

不反制负担：

$$
B_{stay}=NoCounterBurden
$$

反制转移后的负担：

$$
B_{transfer}=WithCounterBurden
$$

反制成本：

$$
CounterCost=BaseValue(counter)\times0.35=8\times0.35=2.8
$$

使用反制 iff：

$$
{ B_{transfer}+2.8<B_{stay} }
$$

# 16. Transition Option Value

`Transition Option` 只处理**当前 StateValue 公式没有完整表达、且不能与已有状态项重复计分的选择权或身份价值**。

总点数：

$$
P_{option}=P_{spyGap}+P_{card}
$$

其中：

$$
P_{card}=\begin{cases}
ScoutOption,&Scout\\
LeverageOption,&Leverage\\
ResourceTransactionOption,&Destroy/Plunder/Transfer\\
0,&otherwise
\end{cases}
$$

最终：
$$
{ V_{option}=\frac{P_{option}}{5} }
$$

## 16.1 Scout / SpyGap 私密信息价值

### 16.1.1 已知/未知牌数量

$$
KnownExpected =\sum_{known\;card}Availability(card)
$$

$$
UnknownCount =\max(0,HandCount-KnownExpected)
$$

$$
ActualNewRevealCount = \min(RevealLimit,\max(0,selection.unknownCount))
$$

Scout 从 canonical selection 读取该值。SpyGap 则由 Simulator 在每次实际生命伤害后记录本次新增未知槽位数；
它会扣除合法已知实体与同一模拟路径已经查看的槽位，因此重复伤害只为仍未知的新牌产生 value。

$$
Revealed=\min(ActualNewRevealCount,UnknownCount)
$$

### 16.1.2 当前牌池身份熵

对每种定义 `d`，Event 提供当前 finite-pool density `p_d`：

$$
{ H=-\sum_dp_d\log_2p_d }
$$

### 16.1.3 四类关键资源不确定性

`d ∈ {assault, block, recover, counter}`：

$$
Uncertainty_d =P_d(1-P_d)\times Relevance_d
$$

若被查看目标是敌人：

$$
DecisionWeightedUncertainty = \sum_d Uncertainty_d
$$

若被查看目标是队友：

$$
DecisionWeightedUncertainty = \\Uncertainty_{assault} + \max( Uncertainty_{block}, Uncertainty_{recover}, Uncertainty_{counter} )
$$

其中 `Relevance_d` 的具体计算公式在 16.1.5 说明

### 16.1.4 Raw information points

$$
InfoPoints =UnknownCount\times H\times\frac{Revealed}{UnknownCount} \times DecisionWeightedUncertainty
$$

即在 `UnknownCount>0` 时也可理解为：

$$
InfoPoints=Revealed\times H\times DecisionWeightedUncertainty
$$

### 16.1.5 `privatePeekDecisionRelevance()` 的四类相关性

先把 actor 手牌实例映射为 `CARD_DEFINITIONS[entry.definitionId] ?? entry`，再得到三个布尔/有界决策量：

$$
OffensiveDecision =clamp\left(\max(E[Assault],I[存在 attack/damage/attack-buff 动作])\right)
$$

$$
TacticDecision=I[存在 counterable tactic]
$$

$$
ProtectionDecision =I[存在 defense/response/rescue/support 或 multiStage 动作]
$$

若被查看目标是敌人：

$$
TargetKillRelevance =clamp\left(\frac{MaxHP-HP}{MaxHP}\right)
$$

对己方所有存活角色， `a` 代表某个己方存活角色：

$$
TeamThreatRelevance =\max_a clamp\left( \frac{MaxHP_a-HP_a}{MaxHP_a} +\frac{IncomingExposure_a}{5} \right)
$$

四类资源 `Relevance`：

$$
R_{assault}=\max(TeamThreatRelevance,ProtectionDecision)
$$

$$
R_{block}=OffensiveDecision
$$

$$
R_{recover}=OffensiveDecision\times TargetKillRelevance
$$

$$
R_{counter}=TacticDecision
$$

若被查看目标是队友：

$$
AllySurvivalRelevance =clamp\left( \frac{MaxHP-HP}{MaxHP}+\frac{IncomingExposure}{5} \right)\times ProtectionDecision
$$

$$
EnemyKillRelevance =\max_{enemy}clamp\left(\frac{MaxHP-HP}{MaxHP}\right)
$$

$$
R_{assault}=EnemyKillRelevance\times\max(OffensiveDecision,TacticDecision)
$$

$$
R_{block}=R_{recover}=R_{counter}=AllySurvivalRelevance
$$

### 16.1.6 Scout transition option

动作执行概率：

$$
ExecutionProbability=Availability(heldCard)
$$

$$
EffectScale=clamp(ExecutionProbability\times ResolutionScale)
$$

其中 `ResolutionScale` 是这张战术牌在反制机制下最终能够结算的概率

$$
{ ScoutOption=InfoPoints\times EffectScale\times0.35 }
$$

## 16.2 Leverage 装备获得选择权

源码：`Evaluator.deriveTransitionOptionPoints()` 的 `leverage` 分支。

原目标装备前后保留概率：

$$
Acquired =\max(0,Retention_{before}-Retention_{after})
$$

装备对 actor 的静态资产：

$$
EquipActorStaticAsset=(BaseEquipValue+RoleDelta(actor,equipment))\times RESOURCE\_MATERIAL\_SCALE
$$

$$
{ LeverageOption =EquipActorStaticAsset\times Acquired }
$$

Base 与 RoleDelta 经同一 static-asset scale；`LeverageOption` 是 Transition Option，会经 `statePointsToUtility()` 进入 Final Utility。借势其它 willingness 与 Search Prior 公式不受影响。

## 16.3 Resource Transaction Option

源码：`Evaluator.resourceTransactionForDefinition()`、`resourceTransactionOptionPoints()`。

该项只评价 Destroy、Plunder、Transfer 已实际移除或转移的手牌身份价值；装备区资源不进入本项。设观察者为 `viewer`，玩家 `p` 持有定义 `c` 时：

$$
{ IdentityValue(p,c)=BaseCardValue(c)\times RESOURCE\_MATERIAL\_SCALE+MissingHandRoleContext(p,c) }
$$

其中：

$$
MissingHandRoleContext(p,c)=
\begin{cases}
0,&p=viewer\\
RoleDelta(p,c),&p\ne viewer
\end{cases}
$$

当前：

$$
RESOURCE\_MATERIAL\_SCALE=0.4
$$

viewer 自己的 `HandRoleDelta` 已作为独立 contextual State term 进入 StateValue。本项只补具体手牌身份的基础材料价值，以及其他玩家缺失的同一 HandRole context；Destroy/Plunder 候选的静态资源规范化由第 21 节定义。

阵营符号统一为：

$$
Sign(p)=
\begin{cases}
+1,&ally\\
-1,&enemy
\end{cases}
$$

同一个 transaction primitive 表示资源从 `source` 转移到 `receiver`：

$$
Transaction(source,receiver,c)=\\Sign(receiver)\times IdentityValue(receiver,c)-Sign(source)\times IdentityValue(source,c)
$$

Destroy 的 `receiver=null`，receiver 项为 0。因此三类动作分别为：

$$
 DestroyResourceOption=-Sign(source)\times IdentityValue(source,c)\times EffectScale 
$$

$$
PlunderResourceOption=\\\left[Sign(actor)\times IdentityValue(actor,c)-Sign(source)\times IdentityValue(source,c)\right]\times EffectScale
$$

$$
TransferResourceOption=\\\left[Sign(receiver)\times IdentityValue(receiver,c)-Sign(source)\times IdentityValue(source,c)\right]\\\times EffectScale
$$

统一写为：

$$
ResourceTransactionOption=E\left[Transaction(source,receiver,c)\right]\times EffectScale
$$

确定身份直接使用该定义。未知身份只查询当前来源匿名 bucket 的 Probability finite-pool：

$$
{ E[Transaction(source,receiver,c)]=\sum_dP(C=d)\times Transaction(source,receiver,d) }
$$

其中：

$$
P(C=d)=slotProbability(sourceBucket,d)
$$

该概率来自 `queryProbability(..., bucketId=source.id).slotProbability`。

`EffectScale` 优先读取 Simulator 为当前 transition 记录的单项实际资源移动事实；协调等后置摸牌不会用净手牌数掩盖已经发生的破坏、掠夺或转移。没有记录事实的独立公式输入回退到以下身份/匿名槽差：

known identity 使用：
$$
EffectScale_{known}=clamp_{[0,1]}\left(Availability_{before}(c)-Availability_{after}(c)\right)
$$

unknown identity 使用：

$$
EffectScale_{unknown}=clamp_{[0,1]}\left(AnonymousSlots_{before}(source)-AnonymousSlots_{after}(source)\right)
$$

这个差值已经表达该资源真实发生移除或转移的概率。

# 17. END Opportunity Penalty

源码：`Evaluator.js endOpportunityPoints()`。

总 END penalty（State Points）：

$$
{ P_{END}=P_f+P_s+P_d }
$$

## 17.1 能量满溢 Pf

设：

- `E` = 当前能量；
- `G` = `baseAmount + teamBonus + equipmentBonus`；
- `Emax` = 最大能量。

$$
Overflow =\max(0,E+G-E_{max})
$$

$$
{ P_f=1.2\times Overflow }
$$

换成 u：

$$
{ P_{f,u}=0.24\times Overflow }
$$

## 17.2 技能能量准备压力 S(E)

若无主动技能或：

$$
E<C
$$

则：

$$
S(E)=0
$$

如果已具备发动权：

$$
{ S(E) =\sqrt{\frac{E-C+1}{E_{max}-C+1}} }
$$

当前代码没有额外经验归一化常量。

例如 `C=2, Emax=4`：

| E | S(E) |
| --- | --- |
| 1 | 0 |
| 2 | 1/√3 ≈ 0.5774 |
| 3 | √(2/3) ≈ 0.8165 |
| 4 | 1 |

## 17.3 普通 Legal skill state-value opportunity

除 X 技能外，每个普通 legal skill sibling 直接复用**同一次 transition evaluation**已经得到的完整 raw StateValue delta：

$$
\Delta_s=V_{state}(Y_s)-V_{state}(X)
$$

Evaluator 在完整 legal skill sibling 集合中选择最佳正变化：

$$
{\Delta_s^+=\max_{s\in LegalSkill}\max(0,\Delta_s)}
$$

该值包含 StateValue 的全部既有分项；不新增第二套价值计算，也不读取 `baseTransition`、TransitionOption 或 continuation。Searcher 只提供完整 sibling transition terms，不聚合价值。

若没有合法技能或所有 legal skill 的 StateValue delta 都不为正：

$$
\Delta_s^+=0
$$

## 17.4 技能机会损失 Ps

普通主动技能：

$$
{P_s^{normal}=S(E)\max(0.75,D(X))\Delta_s^+}
$$

X 技能（孤注）不使用 `S(E)` 或 `D(X)`。令当前能量真实结算的 StateDelta 为：

$$
\Delta_E
$$

在同一当前 World 上仅把用于该技能结算的能量设置为：

$$
E_{next}=\min(E+1,E_{max})
$$

再结算同一技能，得：

$$
\Delta_{E+1}
$$

反事实不推进回合，不加入摸牌阶段、敌方行动或任何其它 World 变化。X 技能的 END 机会项为：

$$
{P_s^X=ENERGY\_STATE\_WEIGHT-(\Delta_{E+1}-\Delta_E)}
$$

当前 `ENERGY_STATE_WEIGHT=1.2`。满能量时 `E_next=E`，因此：

$$
\Delta_{E+1}=\Delta_E\Rightarrow P_s^X=1.2
$$

`P_s^X` 不做非负截断；当下一点能量的边际技能收益大于 `1.2` 时，负值会提高 END 的相对吸引力，表示继续等待。

该项**只减 END candidate**。

技能动作本身不会减 `P_s`。

如果先使用技能后再在新 World 中考虑 END，而主动技能已经不能再用，则此时 legal skill sibling 为空：

$$
\Delta_s^+=0\Rightarrow P_s=0
$$

## 17.5 强制弃牌机会损失 Pd

Pd 该项只在 END 的真实 Simulator 结果确实发生强制弃牌时考虑。 设 END 与同 parent sibling 的原始状态变化分别为：

$$
\Delta_{END} = V_{state}(Y_{END})-V_{state}(X)
$$

$$
\Delta_a = V_{state}(Y_a)-V_{state}(X)
$$

只有 sibling a 与 END 具有相同的动作前溢出量，并且满足：

$$
AfterOverflow_a<BeforeOverflow_a
$$

时才形成 discard relief：

$$
Relief_d(a) = \max(0,\Delta_a-\Delta_{END})
$$

Evaluator 对 Searcher 提供的完整 sibling transition terms 进行价值聚合：

$$
{ P_d=\max_a Relief_d(a) }
$$

没有符合条件的 sibling 时：

$$
P_d=0
$$

该项使用 Raw StateDelta，不识别 Recover、装备或具体卡牌类型。

## 17.6 空装备槽硬约束

$$
BeforeOverflow>0\land \neg HasEquipmentBefore\land ExistsLegalMaterializedEquipmentSibling
\Rightarrow V_{END}=-\infty
$$

## 17.7 END 最终公式

$$
{ V_{END} =V_{baseTransition} -\frac{P_f+P_s+P_d}{5} }
$$

以 Utility 直接表示：

$$
{ P_{END,u} =0.24\times Overflow +\frac{P_s}{5}+\frac {P_d}5 }
$$

# 18. Candidate 比较语义

源码：`Evaluator.compareCandidates()`、`Evaluator.js compareUtilityValues()`。

比较优先级：

1. 两个都是根 Transfer：先比较 Transfer contextual preference；
2. 同一 Destroy/Plunder card + target 的不同 resource choice：
   - 先比较 `ResourceSelectionUtility`；
   - Resource 在统一机器精度 tolerance 内同分时，继续比较 generic Final Utility；
3. 通用比较：`valueScore`（搜索累计值）或 `transitionValue`；
4. Resource 与 Final 都在同一机器精度 tolerance 内时才进入稳定同分规则；
5. 若两者都是同一目标的 Scout，则优先实际新增揭示数 `actualNewRevealCount` 更多的候选；
6. 仍完全同分时：`skill root > card root`；
7. 其它完全等价返回 0。

浮点 tolerance：

$$
{ Tolerance=Number.EPSILON\times\max(1,|V_L|,|V_R|) }
$$

该 tolerance 由 `Evaluator.js compareUtilityValues()` 唯一实现，并同时服务 ResourceSelectionUtility 与 generic Final Utility；Event/Probability 的 `PROBABILITY_EPSILON` 独立用于概率合并。

同根 Destroy/Plunder 的完整层级为：

```text
ResourceSelectionUtility
    ↓ machine-precision tie
Generic Final Utility
    ↓ machine-precision tie
Scout/skill-root 已有稳定规则（适用时）
    ↓ tie
Generator stable enumeration
```

Resource 非 tie 时 Final Utility 无权覆盖资源选择 authority；Resource tie 时也不得提前返回 0 跳过 Final Utility。

# 19. Card / Resource Policy Value 公式

这些值用于资源选择、弃牌、转移、response 或 search prior，本身不直接加进 Final Utility。
## 19.1 已知牌 Transfer Card Value

基础：

$$
V=RoleCardValue(player,card)
$$

然后按牌型增加上下文：

### Recover

- 满血：`-2`
- `HP<=2`：`+7`
- 再加 `min(2, missingHP)`

$$
V_{recover}=Base-2I[HP=MaxHP]+7I[HP\le2]+\min(2,MissingHP)
$$

### Block

$$
V_{block}=Base+6I[HP\le2]
$$

### Charge

缺能：

$$
MissingEnergy=\max(0,MaxEnergy-E)
$$

$$
V_{charge}=Base+\min(2,MissingEnergy)+2I[ActiveSkill\land C>0\land SkillUses<SkillLimit\land E+1≥C]
$$

其中 I[x] 表示指示函数，即

$$
I[x]=\begin{cases}1,\ x\ is\ ture\\ 0,\ x\ is\ false \end{cases}
$$

### Shield

$$
V_{shield}=Base+3I[HP\le2]-2I[Shield\ge2]
$$

### Assault

$$
V_{assault}=Base+1I[AttackUsed<AttackLimit]
$$

## 19.2 匿名 Transfer Card Value

若存在 remaining counts：

$$
 V_{unknownTransfer} =\frac{\sum_dn_dV_d}{\sum_dn_d} 
$$

否则：

$$
UNKNOWN\_HAND\_EXPECTED\_VALUE=5.8
$$

这只是无有效 finite-pool 时的 unknown base expectation，不会作为每张普通手牌的永久 World StateValue。

## 19.3 装备替换 Keep Deduction

旧装备对角色价值：

$$
OldValue=RoleCardValue(character,oldEquipment)
$$

$$
Deduction=OldValue\times Retention
$$

若新旧装备定义相同：

$$
Deduction\;+=4
$$

## 19.4 Discard Keep Value

起点：

$$
Keep=RoleCardValue(character,card)
$$

装备牌：

$$
Keep-=EquipmentKeepDeduction
$$

低血响应牌：

- HP≤1：`+2`
- HP=2：`+1`

其它固定调整：

- stranded assault：`+5`
- 满血 recover：`-2`
- HP≤2 recover：`+7`
- HP≤2 block：`+6`
- symbiosis：`-5`

最终越低越优先弃置。

## 19.5 Destroy / Plunder 已知资源 Utility

### Destroy

$$
 U_{destroy}=RoleCardValue(owner,definition) 
$$

### Plunder

设：

- `A` = 该牌对 actor 的 Role Card Value；
- `O` = 该牌对 owner 的 Role Card Value。

若 owner 是己方：

$$
U_{plunder}=A-O
$$

若 owner 是敌方：

$$
U_{plunder}=A+O
$$

## 19.6 匿名资源 Utility

有剩余池时：

$$
{ E[U]=\frac{\sum_dn_dU_d}{\sum_dn_d} }
$$

无有效池：

- destroy：`UNKNOWN_HAND_EXPECTED_VALUE`
- plunder 己方：`0`
- plunder 敌方：`2 × UNKNOWN_HAND_EXPECTED_VALUE`

## 19.7 匿名获得资源 Utility

$$
{ E[BaseCardValue] =\frac{\sum_dn_dBaseValue_d}{\sum_dn_d} }
$$

无池时回退 `UNKNOWN_HAND_EXPECTED_VALUE = 5.8`。

## 19.8 Energy Device 技能门槛 Policy Value

该值只用于资源选择策略，不进入 Final Utility。

设：

- `C` = 技能费用；
- `L` = 每回合技能次数上限；
- `E0` = 无充能桩下一回合能量；
- `E1` = 有充能桩下一回合能量。

$$
Uses_0=\min(L,\lfloor E_0/C\rfloor)
$$

$$
Uses_1=\min(L,\lfloor E_1/C\rfloor)
$$

$$
LocalValue=\max(0,Uses_1-Uses_0)\times4
$$

行动者视角：

$$
{ ThresholdOption= \begin{cases} -LocalValue,&owner\;ally\\ +LocalValue,&owner\;enemy \end{cases} }
$$

# 20. Transfer 完整局部 Preference

## 20.1 Resource relation utility

资源对来源价值 `Vs`、对接收者价值 `Vr`。

### Ally → Enemy

$$
-\infty
$$

### Ally → Ally

$$
U=V_r-V_s
$$

### Enemy → Ally

$$
U=V_s+V_r
$$

### Enemy → Enemy

$$
U=V_s-V_r
$$

## 20.2 手牌容量调整

来源溢出：

$$
SourceOverflow=\max(0,SourceHand-SourceHP)
$$

接收者空间：

$$
ReceiverSpace=\max(0,ReceiverHP-ReceiverHand)
$$

调整：

- Ally→Ally：`+ min(SourceOverflow, ReceiverSpace) * 4`
- Enemy source overflow：`- min(SourceOverflow,2) * 2`
- Ally receiver 且无空间：`- ReceiverValue * 0.75`
- Enemy receiver 且无空间：`+1`
- 来源为 human ally：`-7`

Enemy→Enemy 额外门槛：

$$
ThreatGap\ge4
$$

且：

$$
Score\ge5
$$

否则：

$$
Score=-\infty
$$

# 21. Destroy / Plunder Resource Selection Comparator

源码：`Evaluator.resourceSelectionPreference()`、`Evaluator.compareCandidates()`。

动作真实应用概率：

- equipment：前后 retention 差；
- hand：前后 handCount 差；

统一 clamp 到 `[0,1]`：

$$
P_{applied}
$$

若：

$$
P_{applied}\le PROBABILITY\_EPSILON
$$

则该 selection preference 为 `-∞`。

先计算真实状态差：

$$
RawStateDelta=V_{state}(Y)-V_{state}(X)
$$

`RawStateDelta` 已包含场上装备的 Base/Role static asset、装备功能变化、hand `1.1 × HandCount`，以及 viewer 已知手牌的独立 `HandRoleDelta`。为了让 hand/equipment 静态资产同尺度比较，先把装备 Base 与 Role 的静态部分一起剥离：

$$
EquipmentStaticAssetDelta=\Delta(EquipmentBaseMaterial+EquipmentRoleDelta)
$$

已知手牌或公开装备经 Plunder 进入 actor 手牌时，viewer 的独立 `HandRoleDelta` 已在 `RawStateDelta` 兑现；为了改由 acquisition static asset 同尺度表示，先移除这一项。匿名 acquisition 没有已兑现身份，因此该项为 0：

$$
ContextualFunctional=RawStateDelta-EquipmentStaticAssetDelta-RealizedActorHandRoleDelta 
$$

动态装备 Future、distance/exposure、HandCount 与动作卡自身的 HandRoleDelta 全部留在 context。设 `ExpectedBaseAiValue` 与 `ExpectedRoleDelta(holder)` 为确定 definition 的值，或当前 remaining finite pool 的合法条件期望；无有效 pool 时 Base 回退 `UNKNOWN_HAND_EXPECTED_VALUE`，Role 回退 0。目标阵营方向：

$$
TargetSign=\begin{cases}+1,&owner\ enemy\\-1,&owner\ ally\end{cases}
$$

目标资源静态资产：

$$
TargetStaticAsset=TargetSign\times(ExpectedBaseAiValue+ExpectedRoleDelta(owner))\times RESOURCE\_MATERIAL\_SCALE\times P_{applied} 
$$

Plunder 获得方静态资产独立使用 actor 的 RoleDelta：

$$
ActorAcquisition=\begin{cases}(ExpectedBaseAiValue+ExpectedRoleDelta(actor))\times RESOURCE\_MATERIAL\_SCALE\times P_{applied},&plunder\\0,&destroy\end{cases}
$$

充能桩技能门槛项继续使用 19.8 的 policy authority：

$$
ThresholdUtility=ThresholdOption\times P_{applied}
$$

最终唯一资源选择标量：

$$
ResourceSelectionUtility=\\ContextualFunctional\\+TargetStaticAsset\\+ActorAcquisition\\+ThresholdUtility
$$

`EquipmentStaticAssetDelta` 先从 `RawStateDelta` 同时剥离装备 Base/Role，再由 `TargetStaticAsset` 以同一语义加回一次；hand static asset 只在本次具体 resource policy 中进入。Plunder 的 target denial 与 actor acquisition 使用各自角色的 RoleDelta，分别表示同一实体的两个所有权后果。

对军火库、回收站与备用弹夹，Destroy/Plunder 没有任何装备名特判：

$$
ContextualFunctional\supset\Delta BattleDeviceFuture+\Delta RecycleDeviceFuture+\Delta AssaultMagazineFuture
$$

Destroy 移除敌方装备时，目标 Future denial 由 `RawStateDelta` 自然成为正 context；Plunder 同时保留目标 denial，并按既有 `ActorAcquisition` 记取得的静态资产。若实际 after World 让获得方装备生效，其新 StateValue Future 同样由 after-before 自然进入；当前真实 Plunder 把装备牌收入手牌时则不会虚构装备已生效。三项 Future 都不会被 `EquipmentStaticAssetDelta` 剥离，也不会再次进入 `TargetStaticAsset`、`ActorAcquisition` 或 threshold。

`ResourceSelectionUtility` 只负责同一 Destroy/Plunder 根资源选择，不再作为额外项加进 Final Utility。比较层级与机器精度 tie contract 见第 18 节：

```text
ResourceSelectionUtility → tie → Generic Final Utility → tie → stable order
```

# 22. Mutual Benefit receipt / Symbiosis

## 22.1 Mutual Benefit receipt

`ReceiptWorlds` 复用同一 `EffectEventWorlds`。令 $B$ 为主动牌支付与 Counter 消费完成、但 receipt 未发生的 baseline World，$Y_c$ 为同一 effect event 成功且领取候选 $c$ 后的 World，$p=P(occurs)$。

$$
DraftValue(c)=\max_{Y\in ReceiptWorlds(c;EffectEventWorlds)}
\left[V_{state}(Y)-V_{state}(B)\right]
$$

$$
c^*=\arg\max_c DraftValue(c)
$$

`ReceiptWorlds` 含留手与合法换装结果。按来源座次依次物化 `{cardId,worldIndex}`；每次选择从生效分支的当前池消耗一张所选定义。

$$
StateDelta_{MutualBenefit}=V_{state}(B)-V_{state}(X)
+p\left[V_{state}(Y_{c^*})-V_{state}(B)\right]
$$

主动牌支付与 Counter 消费只进入 baseline delta；receipt delta 只乘一次同一 effect-event probability。

## 22.2 Symbiosis 直接收益

每名玩家：

$$
Benefit_i=calculateHealAmount(symbiosis.healAmount,MaxHP_i,HP_i)
$$

由 Domain Combat/Card rules 决定真实治疗量。

## 22.3 Team Net Benefit

$$
AllyBenefit=\sum_{ally}Benefit_i
$$

$$
EnemyBenefit=\sum_{enemy}Benefit_i
$$

$$
NetBenefit=AllyBenefit-EnemyBenefit
$$

Search prior 中 `symbiosisNetFromState()`：

$$
{SymbiosisPriorNet=4\times NetBenefit}
$$

# 23. Resource / Response 状态投影

## 23.1 Selected hand resource state value

构造一个只含 1 张 hand 的 CardValue projection：

$$
{ SelectedHandStateValue =HandCountTerm+HandRoleTerm }
$$

匿名牌没有 role identity，因此只保留 `handCount=1.1`。

## 23.2 Selected equipment state value

$$
{ SelectedEquipmentStateValue =EquipmentDelta+EquipmentRoleDelta }
$$

# 24. Counter / Response 价值公式

这一部分决定“要不要响应”，属于响应策略，不直接额外加进 Final Utility；响应真实后果已经通过 Simulator → StateDelta 进入最终价值。

## 24.1 Counter opportunity cost

$$
 C_0=BaseValue(counter)\times0.35 =8\times0.35 =2.8 
$$

## 24.2 Dynamic Counter 的 STAY / RESPOND 边际修正

设：

```text
A = root actor
B = responder
```

Counter prediction 使用的是 `B` 的合法信息边界。

对每个 future resource candidate `s`，定义：
$$
\hat U_{A|B}(s)
$$
表示 `B` 基于自己当前合法掌握的 World、ProbabilityState 与公开信息，对 `A` 在 future selection 中选择 `s` 的价值估计。

这里的 `A|B` 表示：

```text
从 B 的信息边界预测 A 的选择价值
```

不表示构造 `A` 的真实私人 World，也不建立二阶 belief。

private hand 在 prediction 中统一表示为 anonymous-hand candidate；public equipment 保持 exact。

资源类 root 的 Counter window 先于 resource selection。定义 Counter chain 后的
canonical future selection outcomes：
$$
\mathcal S_B=\{s\}
$$

对应权重为 $q_s$，且：

$$
\sum_s q_s=1
$$

确定性 selection policy 使用：

$$
s^*=\arg\max_{s\in\mathcal S_B}\hat U_{A|B}(s),\qquad q_{s^*}=1
$$

每个 outcome 的 root flip gain 为 $G_s$，Counter 损失概率为 $p_C(s)$，自身 Counter
保留重叠为 $O_C(s)$。聚合量为：
$$
G=\sum_s q_sG_s
$$

$$
p_C=\sum_s q_sp_C(s)
$$

$$
O_C=\sum_s q_sO_C(s)
$$

Counter opportunity cost 基线为：

$$
C_0=2.8
$$

当前 root 在 `STAY` 世界中使响应者失去一张 Counter 的概率为：

$$
p_C=P(Counter\ lost\ by\ current\ root\ in\ STAY)
$$

Counter payment 的真实边际机会成本为：

$$
C_{effective}=C_0(1-p_C)
$$

定义因 root 被取消而产生的“响应者自己保住该 Counter”重叠收益：

$$
O_C=\text{Gain 中与 Counter payment 重叠的自身 Counter 保留价值}
$$

则有效收益为：

$$
G_{effective}=G-O_C
$$

最终使用严格大于：

$$
Counter\iff G_{effective}>C_{effective}
$$

即：

$$
{Counter\iff G-O_C>C_0(1-p_C)}
$$

future selection 为 hand 时，响应者手牌中的 Counter 数量为 $c$，其它手牌数量为 $x$：

$$
p_C(hand)=\frac{c}{c+x}
$$

future selection 为 equipment 时：

$$
p_C(equipment)=0
$$

equipment 的保护价值包含在 $G_s$；equipment 不进入 hand 分母。

## 24.3 Global Benefit Counter

令 root 全体受益净值：

$$
N=NetBenefit
$$

若当前 counter depth 为偶数，则不反制时 root 生效：

$$
Stay=N,\quad Flip=0
$$

若为奇数：

$$
Stay=0,\quad Flip=N
$$

最终：

$$
{Counter\iff Flip-Stay>2.8}
$$

特殊保护：首层若 root source 是己方且 `allyBenefit>=0`，直接不反制。

# 25. Block willingness

采用硬布尔合同。

先要求：

$$
AvailableBlocks\ge RequiredBlocks
$$

定义：

$$
Lethal=(IncomingDamage-Shield\ge HP)
$$

$$
LowHP=(HP\le2)
$$

$$
BlocksAbundant=(2\times AvailableBlocks\ge HandCount)
$$

最终：

$$
{ Block\iff SmallTeam\lor Lethal\lor LowHP\lor BlocksAbundant }
$$

# 26. Guardian Aid

## 26.1 Planning 近似

条件伤害减少：`Reduction`，触发概率 `p`。

$$
MitigationValue=Reduction\times p\times5
$$

支付一张手牌：

$$
PaymentValue=p\times1.1
$$

$$
AidValue=MitigationValue-PaymentValue
$$

`StayValue=0`。

未来库存机会成本上限：

$$
Threshold=\min(5,FutureInventory)
$$

使用护援 iff：

$$
{AidValue-StayValue>Threshold}
$$

Runtime 配对世界则直接以两个 World 的 `stateUtility` 得到 `AidValue/StayValue`，比较规则不变。

# 27. Dying Rescue 救援价值

## 27.1 目标行动资产

战略角色标签：`support/healer/damage/control/tank`。

$$
ActionValue =1.25\times HandCount +1.1\times Energy +2I[hasEquipment] +3I[strategic]
$$

若己方仅剩≤2名存活角色：

$$
ImmediateDefeatRisk=true
$$

## 27.2 最后一张 Recover penalty

$$
LastRecoverPenalty= \begin{cases} 3,&AvailableRecover\le1\land ResponderHP\le2\\ 1.5,&AvailableRecover\le1\land ResponderHP>2\\ 0,&AvailableRecover>1 \end{cases}
$$

## 27.3 生存价值

$$
{ SurvivalValue =5+ActionValue+8I[ImmediateDefeatRisk] }
$$

## 27.4 Recover 机会成本

$$
{ RecoverOpportunityCost =BaseValue(recover)\times0.35+LastRecoverPenalty }
$$

因为 `BaseValue(recover)=6`：

基础成本：

$$
6\times0.35=2.1
$$

## 27.5 Expected Rescue Value

$$
{ ExpectedRescueValue =P_{success}\times SurvivalValue-RecoverOpportunityCost }
$$

一般 AI 救援 iff：

$$
ExpectedRescueValue>0
$$

但：

- 自救在满足容量且非 guaranteed impossible 时直接 true；
- 配置允许时 AI 救真人队友可强制 true；
- 敌方/无资源/guaranteed impossible 恒 false。

## 27.6 Rescue success probability

已知 Recover 容量：

$$
KnownCapacity
$$

未知槽位数：

$$
UnknownSlots
$$

剩余池 Recover 数：

$$
K
$$

剩余池总数：

$$
N
$$

还需要的未知 Recover 张数：

$$
RequiredUnknown =\max(0,\lceil Need/HealAmount\rceil-KnownCapacity)
$$

Event/Probability 使用有限池超几何：

$$
{ P_{success} =P(X\ge RequiredUnknown),\quad X\sim Hypergeometric(N,K,UnknownSlots) }
$$

$$
P_{success}=\begin{cases}
1,&KnownFeasibleRecovery\ge Need\ \lor\ RequiredUnknown\le0\\
0,&RequiredUnknown>0\land(MaximumFeasibleRecovery<Need\ \lor\ N\le0)\\
P(X\ge RequiredUnknown),&otherwise
\end{cases}
$$

# 28. Planning Dying Rescue 近似

`decidePlanningDyingRescue()` 在搜索模拟中不展开 runtime 的完整匿名救援链，而使用当前 canonical Probability 的团队 Recover 期望：

$$
TeamRecover=\sum_{ally}E[Recover]
$$

设单张 Recover 治疗量为 `H_r`，当前需要恢复：

$$
Need=\max(1,context.need)
$$

确定不可能：

$$
GuaranteedImpossible=(TeamRecover\times H_r<Need)
$$

规划成功概率近似：

$$
{ P_{success}^{planning} =\min\left(1,\frac{TeamRecover\times H_r}{Need}\right) }
$$

随后仍调用同一个 `dyingRescueValueTerms()`：

$$
ExpectedRescueValue =P_{success}^{planning}\times SurvivalValue-RecoverOpportunityCost
$$

所以 planning/runtime 只改变成功概率事实的精度，不复制价值权重。

# 29. Assault Discard 响应合同

`shouldRespond()` 对 `assaultDiscard` 的冻结规则：

### Provoke

$$
{DiscardAssault\iff HP\le2\;\lor\;HandCount>2}
$$

### Duel

$$
{DiscardAssault=true}
$$

### 其它 assault-discard 场景

令自己已知 Assault 数为 `A`：

$$
{DiscardAssault\iff HP\le2\;\lor\;A>1}
$$

该部分只用于响应 policy，不进入 Final Utility。

# 30. 当前突袭已知被动加伤

`knownPendingAssaultBonus()` 只读取公开可知的被动预览：

$$
{ KnownBonus =I[momentum]\cdot Momentum +I[gamble]\cdot AssaultBonus }
$$

Block willingness 中实际 `IncomingDamage` 会加上该已知 bonus。

# 31. Leverage Assault willingness

源码：`Evaluator.js`。

设：

- `EV_assault` = 第一目标可用突袭期望；
- `P_block` = 第二目标格挡概率；
- `EquipValue` = 第一目标装备基础 AI 值。

友伤惩罚：

$$
FriendlyFirePenalty= \begin{cases} 0.55,&sameTeam\\ 0,&enemy \end{cases}
$$

防御风险：

$$
DefenseRisk=\min(0.9,P_{block})
$$

目标价值：

$$
TargetValue= \begin{cases} -0.35-0.15I[HP\le2],&ally\\ +0.30+0.15I[HP\le2],&enemy \end{cases}
$$

若突袭期望≤0.75：

$$
ConservePenalty=0.18
$$

否则 0。

意愿分：

$$
{ W =0.42 +0.04\times EquipValue +TargetValue -FriendlyFirePenalty -0.2\times DefenseRisk -ConservePenalty }
$$

使用 iff：

$$
{W\ge0.5}
$$

# 32. Planning Dynamic Counter Gain 按卡牌公式

前提：root actor 必须是 responder 的敌人，否则 gain=0。

## shockwave

$$
{ Gain=5\times(1-P_{block})\times I[Shield<1] }
$$

## provoke

$$
{ Gain= \begin{cases} 1.1,&P(target\;assault)>0\\ 5,&otherwise \end{cases} }
$$

## duel

$$
{ Gain=5\times \begin{cases} 0.5,&P(target\;assault)>0\\ 1,&otherwise \end{cases} }
$$

## scout

未知牌数：

$$
UnknownCount=HandCount-KnownCount
$$

$$
Info=\min(2,UnknownCount)\times0.35
$$

敌方 root 时 gain 为正。

## harvest

$$
{Gain=2\times1.1=2.2}
$$

## charge

$$
{Gain=1.2}
$$

## exposeWeakness

$$
{Gain=1.5}
$$

## plunder

有明确 selection 时：

$$
Gain=SelectedOwnerResourceStateValue + \begin{cases} SelectedActorResourceStateValue,&hand\\ 1.1,&equipment \end{cases}
$$

`uniform-hand` 的单张资源状态值：

$$
UnknownMass=\max(0,HandCount-KnownMass)
$$

$$
UniformHandValue=\frac{KnownWeightedValue+UnknownMass\times AnonymousSingleValue}{HandCount}
$$

没有 selection 时：

$$
Gain=2.2+Threat
$$

若目标合法已知有 assault：

$$
Threat=5
$$

否则 0。

## destroy

明确 selection：直接使用被移除资源的 StateValue 投影。

无 selection：约为：

$$
Gain=1.1
$$

## transfer

来源价值 `FromValue`、接收者价值 `ReceiverValue`：

$$
Gain =(FromAlly?FromValue:-FromValue) +(ReceiverAlly?-ReceiverValue:ReceiverValue)
$$

## counter

$$
{Gain=BaseValue(counter)=8}
$$

## seal / lightning

$$
{Gain=2.8}
$$

## leverage

敌方且目标有装备：`+2`；否则 `-2`。

最后是否反制仍统一比较：

$$
G-O_C>C_0(1-p_C)
$$

其中非资源 root 的 $p_C=0$、$O_C=0$，因此退化为 $Gain>2.8$。

# 33. Seal Counter

当前剩余判定池给出 tactic judgment probability：

$$
P_{tactic}
$$

封印跳过概率：

$$
P_{skip}=1-P_{tactic}
$$

可避免负担：

$$
{ PreventedBurden =P_{skip}\times TurnOpportunity(holder) }
$$

反制 iff：

$$
{PreventedBurden>2.8}
$$

# 34. Root Counter paired-world gain

当 Controller/Simulator 已准备 root 的 `baseWorld` 与 `resolvedWorld`：

$$
RootEffectValue =V_{state}(Resolved)-V_{state}(Base)
$$

Mutual Benefit 的 `Resolved` 为按 `EffectEventWorlds` 物化全部 receipt 的 World。

若当前 `STAY` 会让 root 生效（`resolvesAtStay=true`）：

$$
{FlipGain=-RootEffectValue}
$$

否则：

$$
{FlipGain=+RootEffectValue}
$$

之后仍统一使用第 24.2 节的边际修正：

$$
{FlipGain-O_C>C_0(1-p_C)}
$$

判断是否反制。

# 35. Guardian STAY/AID paired-world value

Runtime 已有两个配对 World：

$$
StayValue=V_{state}(StayWorld|guardian)
$$

$$
AidValue=V_{state}(AidWorld|guardian)
$$

并从原始 World 读取目标的：

$$
FutureInventory
$$

最终仍使用共享合同：

$$
{ AidValue-StayValue>\min(5,FutureInventory) }
$$

# 36. Leverage Response Block Risk

由当前 finite-pool block density `d_block`：

$$
{ BlockRisk =\min(0.85,HandCount\times d_{block}) }
$$

仅作为 `decideLeverageAssault()` 的 runtime fact。

# 37. Search Scheduling 公式

## 37.1 Root Scheduling 通用归一化

任何 root 的原始 `score` 除以预计分支工作量：

$$
Density=\frac{Score}{BranchingWork}
$$

再有界化：

$$
{ RootSchedulingScore =\frac{Density}{1+|Density|} }
$$

因此始终压缩在 `(-1,1)`。

END：

$$
RootSchedulingScore(END)=-\infty
$$

即仅保证合法 non-END 先展开。

## 37.2 Skill root scheduling raw score

| **SkillRaw score** |                                     |
| ------------------ | ----------------------------------- |
| breakArmy          | actor 对 assault 的 Role Card Value |
| barrier            | target missing HP                   |
| symbiosis          | target missing HP                   |
| stealSkill         | `5 + min(4, targetResourceCount)`   |
| burningField       | `8`                                 |
| hunt               | `7 + 7*I[target.hp<=2]`             |
| allIn              | `max(0,E-1)*3`                      |
| resonance          | `5 + 3*I[target.handCount<=1]`      |
| fallback           | `4`                                 |

若技能 targetType 是 `enemyWithCardsOrEquipment`：

$$
BranchingWork=1+TargetResourceCount
$$

否则 1。

## 37.3 Card root scheduling raw score

初始：

$$
Score=RoleCardValue(actor,card)
$$

攻击/决斗对敌人：

$$
Score+=MissingHP\times3 +5I[HP\le2] +8I[HP\le1]
$$

攻击己方：`-12`。

不可反制且有 `baseDamage` 的敌方攻击：

$$
Score+=BaseDamage\times5
$$

Plunder/Destroy 资源量：

$$
Score+=\min(5,TargetHand+EquipmentWeight)
$$

其中装备权重：plunder=1、destroy=2。

己方资源目标：再 `-30`。

Charge：

$$
Score+=1.5\times max(0,MaxEnergy-E)
$$

若这 1 点能量刚好跨过主动技能费用门槛且本回合技能仍有剩余使用次数：再 `+4`。

Transfer：若 `selection.score` 有效，则直接用它作为 score。

已有装备再打装备：减 `EquipmentKeepValueDeduction`。

## 37.4 Root Branching Work

初始：

$$
BranchingWork=1
$$

隐藏资源选择牌：

$$
BranchingWork+=ResourceCount(source)
$$

攻击牌：

$$
BranchingWork+=\sum_{target} (P(block\ge1)+P(block\ge2))
$$

可反制牌：

$$
BranchingWork+=1+\sum_{responders}P(counter)
$$

# 38. Beam Action Utility / Search Prior

## 38.1 END prior

若还有手牌：

$$
ActionUtility(END)=-0.8
$$

否则 0。

该值只用于 search prior，不进入 END Final penalty。

## 38.2 Skill action prior

| **Skill****`actionUtility`** |                                                   |
| ---------------------------- | ------------------------------------------------- |
| breakArmy                    | `breakArmyUtility()`                              |
| barrier                      | 0                                                 |
| symbiosis                    | 0                                                 |
| stealSkill                   | `5 + min(4,target hand + equip?1:0)`              |
| burningField                 | 0（另有 searchCredit=8）                          |
| hunt                         | `7 + 7*I[target.hp<=2]`                           |
| allIn                        | `max(0,E-1)*3 + min(1,E*0.25)*(1-assaultBonus)*4` |
| resonance                    | `5 + 3*I[target.handCount<=1]`                    |
| fallback                     | 4                                                 |

`stealSkill` 与 `hunt` 再加：

$$
TargetPriority(target)
$$

## 38.3 breakArmyUtility

手中突袭有效数量：

$$
A=\sum_{assault\;card}Availability(card)
$$

剩余基础攻击次数：

$$
L=\max(0,AttackLimit-AttackUsed)
$$

可兑现额外容量：

$$
Extra=\min(1,\max(0,A-L))
$$

$$
{ BreakArmyPrior=Extra\times RoleCardValue(actor,assault) }
$$

## 38.4 Lightning action prior

$$
{ Prior_{lightning} =BaseValue(lightning) +0.4\times U(LightningLifecyclePoints) +IdentityDelta }
$$

## 38.5 Seal action prior

见第 39 节 `sealUseValue()`。

## 38.6 攻击目标 focus prior

$$
Focus =MissingHP\times3 +5I[HP\le2] +8I[HP\le1]
$$

Assault 对敌人加入完整 Focus。

其它 enemy attack/duel（排除 assault、shockwave）：

$$
+3+Focus
$$

攻击己方：`-12`。

## 38.7 Resource / Charge / Transfer / Equipment prior

Plunder / Destroy 的公开资源数量：

$$
ResourceCount=HandCount+EquipmentWeight
$$

其中 `EquipmentWeight=1` 用于 Plunder，`EquipmentWeight=2` 用于 Destroy；无装备时为 0。

$$
ActionUtility+=\min(5,ResourceCount)
$$

资源目标为队友时：

$$
ActionUtility-=30
$$

Assault、Duel、Plunder、Destroy 的敌方单目标加入 `TargetPriority(target)`；Shockwave 不加入该项。

Charge：

$$
ActionUtility+=1.5(MaxEnergy-E)+4I[E<C\land E+1\ge C\land SkillUsesRemaining]
$$

Transfer：

$$
ActionUtility+=SelectionScore
$$

已有装备时使用装备牌：

$$
ActionUtility-=EquipmentKeepValueDeduction
$$

## 38.8 Scout prior

$$
RevealCoverage =\frac{\min(ActualNewRevealCount,UnknownCount)}{RevealLimit}
$$

$$
{ ScoutPriorBonus =BaseValue(scout)\times RevealCoverage\times ScoutDecisionRelevance }
$$

## 38.8.1 `scoutDecisionRelevance()` 的轻量 prior 公式

该函数与正式 `privatePeekInformationValue()` 不同，只是 **Search Prior** 的廉价代理。

三类关键资源概率：

$$
p_A=P(assault),\quad p_B=P(block),\quad p_C=P(counter)
$$

把 Bernoulli 方差按最大值 `0.25` 归一化：

$$
U_A=\frac{p_A(1-p_A)}{0.25},\quad U_B=\frac{p_B(1-p_B)}{0.25},\quad U_C=\frac{p_C(1-p_C)}{0.25}
$$

`OffensiveDecision / TacticDecision / ProtectionDecision` 与私密信息 relevance 使用同类公开决策事实。

### 查看敌人

$$
TeamThreat=\max_{ally}clamp\left( \frac{MaxHP-HP}{MaxHP}+\frac{IncomingExposure}{5} \right)
$$

$$
{ ScoutRelevance =clamp\left(\max( U_B\cdot OffensiveDecision, U_C\cdot TacticDecision, U_A\cdot\max(TeamThreat,ProtectionDecision) )\right) }
$$

### 查看队友

$$
AllySurvival =clamp\left( \frac{MaxHP-HP}{MaxHP}+\frac{IncomingExposure}{5} \right)\cdot ProtectionDecision
$$

$$
EnemyKill=\max_{enemy}clamp\left(\frac{MaxHP-HP}{MaxHP}\right)
$$

$$
{ ScoutRelevance =clamp\left(\max( AllySurvival\cdot\max(U_B,U_C), EnemyKill\cdot\max(OffensiveDecision,TacticDecision)\cdot U_A )\right) }
$$

## 38.9 Provoke prior

对所有存活敌人：

$$
{ Bonus =\sum_e(1-P_e(assault))\times3 }
$$

## 38.10 Duel prior

$$
{ Bonus =(E[Assault_{actor}]-E[Assault_{target}])\times2 }
$$

## 38.11 Symbiosis prior

先：

$$
Net=4\times GlobalBenefitNet
$$

然后：

$$
{ Value= \begin{cases} 8+Net+IdentityDelta,&Net>0\\ -9+Net+IdentityDelta,&Net\le0 \end{cases} }
$$

# 39. Seal Search Prior

非法目标：

$$
SealUseValue=-50
$$

合法目标：

Event 提供未来目标被封印后：

$$
P_{skip}
$$

座次 gap：行动者之后到目标行动前的存活角色数。

$$
Timing =\max(0.7,1-0.1\times Gap)
$$

未来折扣：

$$
FUTURE\_DISCOUNT=0.65
$$

$$
{ SealUseValue =BaseValue(seal) +P_{skip}\times TurnOpportunity(target)\times0.65\times Timing }
$$

这只进入 search prior，不进入 Final StateDelta。

# 40. Target Priority

源码：`StateValue.targetPriorityScore()`、`Evaluator.targetPriority()`。

基础：

$$
TargetPriorityScore =(MaxHP-HP)\times2.5
$$

再加：

- 输出类 role/tag：`+4`
- 支援/治疗/坦克/控制类：`+3`
- `HP+Shield <= expectedDamage`：`+24`
- `exposed / exposeWeakness / huntMark`：`+4`
- `recentAggressorCount * 2`

非敌方：`-∞`。

难度缩放 target prior：

$$
{TargetPriority =TargetPriorityScore\times TARGET\_PRIORITY\_WEIGHT\times DifficultyMultiplier}
$$

其中 `TARGET_PRIORITY_WEIGHT=0.12`，由 Evaluator 作为 Target Priority Search Prior 的唯一权重 authority。

非敌方或倍率 0：返回 0。

# 41. Hidden / Domain Search Prior

## 41.1 Assault hidden block prior

对 Searcher 提供的匿名 hidden-world 样本：

$$
BlockSampleRate =\frac{\#\{world:target\;contains\;block\}}{N}
$$

$$
{HiddenPrior=-1.5\times BlockSampleRate}
$$

仅 assault。

## 41.2 Expose / Assault marginal domain prior

Searcher 通过 paired worlds 得到：

- `exposeMarginal`
- `assaultStacksCredit`

$$
{DomainPrior =0.4\times U(exposeMarginal+assaultStacksCredit)}
$$

## 41.3 Burning Field search credit

$$
SearchCredit=8
$$

其它动作 0。

## 41.4 总 Search Prior

$$
{SearchPrior =HiddenPrior +ActionUtility +SearchCredit +DomainPrior}
$$

所有这些都明确不进入 Final Utility。

# 42. Expose Weakness paired-world marginal

## 42.1 正边际

$$
PositiveMarginal =\max(0,V_{state}(Boosted)-V_{state}(Baseline))
$$

## 42.2 Root provenance

$$
Provenance_0=\max(0,RootExposeStacks)
$$

Assault 当前可兑现 provenance：

$$
StackCount= \begin{cases} RemainingProvenance,&action=assault\\ 0,&otherwise \end{cases} 
$$

Assault 后剩余 provenance：

$$
P_{next} =\max\left(0,P_{current}\times\max\left(0,\frac{Stacks_{after}}{Stacks_{before}}\right)\right)
$$

非 assault 动作保持不变。

# 43. Response Counterfactual 诊断公式

这部分只做 diagnostics，不重复计入 Final Utility。

实际 World 与移除指定响应能力的反事实 World：

$$
GrossAvoided =\max(0,HP_{actual}-HP_{counterfactual})\times5
$$

Defender 自己视角：

$$
OwnerValue =V_{state}(Actual|defender)-V_{state}(Counterfactual|defender)
$$

Viewer 视角：

$$
Projected =V_{state}(Actual|viewer)-V_{state}(Counterfactual|viewer)
$$

`Projected` 仅用于 response attribution ledger，不再次加进 transition value。

# 44. Owner Ledger / Diagnostic Projection

before ledger 使用 before ProbabilityState 的 Radar judgment；after ledger 使用 after ProbabilityState 的 Radar judgment。

对每个 owner 和每个 value field：

$$
{FieldDelta=AfterField-BeforeField}
$$

Owner total：

$$
{OwnerTotal=\sum Fields}
$$

Seal 的 owner-local StateValue contribution：

$$
SealOwnerValue=-LocalSealBurden
$$

阵营符号只在 Viewer projection 施加一次。

字段分类：

- generic：handCount
- material：hp、shield、hp3Risk、hp2Risk、stacks、equipmentDelta、energyDeviceFuture、bubbleMachineFuture、battleDeviceFuture、recycleDeviceFuture、assaultMagazineFuture、death
- threat：markThreat、residualExposureValue、radarFuture
- specific：handRoleDelta、equipmentRole
- outcome：danger
- teamBurden：lightning、seal
- teamValues：每个 battleTeam 一条 rescueReserve

对每个 owner：

$$
\sum CategoryFields=OwnerTotal
$$

Viewer 投影：

$$
Self=U(SelfOwnerTotal)
$$

$$
Ally=U(\sum AllyOwnerTotal+\sum AllyTeamValue)
$$

$$
Enemy=U(\sum EnemyOwnerTotal+\sum EnemyTeamValue)
$$

$$
{ ProjectedTotal=Self+Ally-Enemy }
$$

该 total 应等于相同 before/after StateDelta 的 HP-equivalent utility，只用于诊断一致性。

# 45. Event / Probability 已有量：Evaluator 只消费，不重新定义

以下量均由 `ai/Event/Probability` 提供，Evaluator 不另建概率状态。
`
## 45.1 `PROBABILITY_EPSILON`

$$
{PROBABILITY\_EPSILON=10^{-12}}
$$

源码：`Event/Probability/Branch.js`。

## 45.2 `clampProbability(x)`

$$
{clamp(x)=\max(0,\min(1,x))}
$$

非数值按 0。

## 45.3 `cardAvailability(card)`

$$
{Availability=clamp(card.availability\;??\;1)}
$$

## 45.4 `queryPlayerHandProbability(...)`

Evaluator 使用其输出：

- `.probability`：事件概率，例如“至少有一张 assault”；
- `.expected`：期望数量；
- `.distribution`：数量分布。

具体 finite-pool 算法由 Event/Probability 唯一拥有，Evaluator 不展开真实隐藏实体。

## 45.5 `queryCurrentCardCounts(probabilityState)`

返回当前有限剩余牌池的定义计数，用于：

- Radar judgement；
- Scout entropy；
- Mutual Benefit receipt pool；
- anonymous resource expectation；
- rescue hypergeometric；
- response density。

## 45.6 `probabilityFromCurrentCounts(counts,id)`

返回给定 definition 在当前有限池中的 density/probability primitive。

Evaluator 用于：Scout entropy、Leverage block risk、rescue density 等。

## 45.7 `hypergeometricProbabilityAtLeast(...)`

救援未知 Recover 数量计算使用的无放回超几何尾概率。

## 45.8 `buildRadarJudgmentProbabilities(...)`

从当前 remaining finite pool 返回：

- `.tactic`：Radar 判为 tactic 的概率；
- `.equipment`：判为 equipment 的概率；
- `.basic[definitionId]`：每个基础牌定义的判定概率；
- `.hasJudgmentPool`：当前是否存在有效判定池。

Evaluator 使用 `.tactic` 计算 exposure mitigation 与 avoided Block demand，并使用 `.basic` 计算 expected basic judgment draw value；StateValue 不复制类别概率或 finite-pool 算法。

## 45.9 `tacticJudgmentProbability(...)`

用于 Seal counter：

$$
P_{skip}=1-P_{tacticJudgment}
$$

## 45.10 `sealOutcomeProbabilities(...).skipAction`

Seal 生命周期的实际跳过行动概率；用于正式 `sealTeamBurden` 和 Seal prior。

## 45.11 `getRangeConditionBranches(...)`

返回望远镜/屏障等共享距离条件的联合概率世界；`assaultRangeAllocation()` 在此基础上分配有限突袭库存。

# 46. Domain 已有规则量：Evaluator 只读取

## 46.1 `getMaxEnergy(player)`

唯一最大能量规则 authority；用于：

- energyDevice future value；
- END overflow；
- END skill readiness。

## 46.2 `getTurnEnergyBreakdown(player)`

提供：

- `baseAmount`
- `teamBonus`
- `equipmentBonus`

END 中：

$$
G=baseAmount+teamBonus+equipmentBonus
$$

## 46.3 `activeSkillCost`

Canonical World 已携带正式技能费用；普通技能的 END `S(E)` 不重新读取/解释技能定义。
X 技能反事实只使用 canonical World 的 `energy/maxEnergy` 与真实 Simulator 结算。

## 46.4 `getRecoverHealAmount()` / `calculateHealAmount()`

分别用于：

- 濒死救援所需 Recover 数量；
- Symbiosis 的真实治疗量。

## 46.5 `getAliveRing()`

只用于 Seal 的座次 timing prior。

## 46.6 `getRequiredBlockCount()`

Block demand 数量的 Domain authority。Radar `expectedBlockDemand()` 读取普通需求与军火库需求；每个独立需求对应一次 judgment opportunity，StateValue 不硬编码军火库数量。

# 47. 全部模块级数值常量总表

## 47.1 StateValue.js

| **常量值类型**             |      |                            |
| -------------------------- | ---- | -------------------------- |
| `HP_VALUE`                 | 5    | State/Final 单位 authority |
| `ENERGY_STATE_WEIGHT`      | 1.2  | EnergyDeviceFuture / END overflow / X-skill patience |
| `DANGER_VALUE`             | 7    | State Value                |
| `DEATH_VALUE`              | 28   | State Value                |
| `SHIELD_RESERVE_WEIGHT`    | 2    | State Value                |
| `SHIELD_PROTECTION_WEIGHT` | 0.5  | State Value                |
| `HP3_RISK_WEIGHT`          | 0.2  | State Value                |
| `HP2_RISK_WEIGHT`          | 0.6  | State Value                |

## 47.2 CardValue.js

| **常量值类型**                   |      |                             |
| -------------------------------- | ---- | --------------------------- |
| `RESOURCE_MATERIAL_SCALE`        | 0.4  | static card/equipment asset 唯一换算尺度 |
| `UNKNOWN_HAND_EXPECTED_VALUE`    | 5.8  | no-pool unknown base expectation 唯一 authority |
| `HAND_COUNT_VALUE`               | 1.1  | hand-count StateValue       |
| `RESPONSE_SURVIVAL_BONUS_DANGER` | 1    | discard policy              |
| `RESPONSE_SURVIVAL_BONUS_LETHAL` | 2    | discard policy              |
| `SKILL_THRESHOLD_POLICY_BONUS`   | 4    | resource policy             |

`RESOURCE_MATERIAL_SCALE` 的 production 消费点与职责：

| owner / function | material fact | classification |
| --- | --- | --- |
| `CardValue.staticCardAssetValue()` | `(Base + RoleDelta) × scale` | static card/resource asset 唯一 primitive |
| `CardValue.cardPlayerValueTerms()` | equipment Base/Role static asset | State Value；只经 state delta 进入 Final |
| `CardValue.realizedHandCardStateValue()` | `HandCount + viewer-own HandRoleDelta` | 普通手牌 StateValue 与装备 Future resource 唯一 primitive |
| `Evaluator.resourceTransactionForDefinition()` | hand identity base material + 非 viewer 缺失 HandRole context | Transition Option；Role context 保持 HandRoleDelta 现有尺度，不属于 static-asset 重标 |
| `Evaluator.deriveTransitionOptionPoints()` leverage 分支 | 获得装备的 actor static asset | Transition Option；经 `/5` 进入 Final |
| `Evaluator.resourceSelectionPreference()` | Destroy/Plunder target/acquisition static asset | Resource Policy；不额外加入 Final |

`UNKNOWN_HAND_EXPECTED_VALUE` 只由 `getUnknownTransferCardValue()`、`getResourceUnknownUtility()` 与 `getUnknownAcquisitionUtility()` 在无有效 finite-pool 时消费；enemy Plunder 通过 `2 × UNKNOWN_HAND_EXPECTED_VALUE` 推导，不存在 `11.6` 第二 authority。

## 47.3 Evaluator.js

| **常量值类型**                        |      |                          |
| ------------------------------------- | ---- | ------------------------ |
| `MIN_TRANSFER_UTILITY`                | 0.5  | Transfer competitiveness |
| `HUMAN_ALLY_HAND_PROTECTION`          | 7    | Transfer policy          |
| `MIN_ENEMY_REDISTRIBUTION_THREAT_GAP` | 4    | Transfer policy          |
| `MIN_ENEMY_REDISTRIBUTION_UTILITY`    | 5    | Transfer policy          |
| `FUTURE_DISCOUNT`                     | 0.65 | Seal search prior        |
| `MIN_TURN_TIMING_FACTOR`              | 0.7  | Seal search prior        |
| `TURN_TIMING_STEP`                    | 0.1  | Seal search prior        |
| `BURNING_FIELD_SEARCH_PRIOR`          | 8    | Search prior             |
| `STATE_UTILITY_PRIOR_WEIGHT`          | 0.4  | Search prior             |
| `TARGET_PRIORITY_WEIGHT`              | 0.12 | Target priority search prior |
| `END_PRIOR_PENALTY`                   | 0.8  | Search prior only        |
| `SKILL_THRESHOLD_PRIOR_BONUS`         | 4    | Search prior             |

## 47.4 Event

| **常量值Owner**       |         |                          |
| --------------------- | ------- | ------------------------ |
| `PROBABILITY_EPSILON` | `1e-12` | Event/Probability/Branch |

另外大量公式中存在局部冻结系数，例如：

- Counter cost `×0.35`
- Scout transition information `×0.35`
- Assault hidden prior `-1.5`
- Root density `x/(1+|x|)`
- Provoke prior `×3`
- Duel inventory gap `×2`
- Seal future discount `0.65`
- Leverage willingness 的 `0.42 / 0.04 / 0.55 / 0.2 / 0.18 / 0.5`

这些均已在各自公式章节逐项列出。

# 48. 明确不进入 Final Utility 的值

以下虽然都由 Evaluator/CardValue/StateValue 计算，但**只用于搜索、策略或诊断**：

- `rootSchedulingScore()`
- `actionUtility()`
- `actionSearchPrior()`
- `hiddenWorldPrior()`
- `composeSearchPrior()`
- `targetPriorityScore()` / `targetPriority()`
- `sealUseValue()`（主动使用封印的 search prior）
- `getDiscardKeepValue()`
- `getTransferCardValue()`
- `evaluateTransferSelection().score`
- `resourceSelectionPreference()`（只用于特定资源选择 comparator）
- `counterOpportunityCost()` / response willingness values
- `planningDynamicCounterGain()`
- `decideLeverageAssault()` willingness
- `dyingRescueValueTerms()` response policy
- diagnostics ledger / response attribution

它们不能和 `StateValue(Y)-StateValue(X)` 再相加，否则会形成 double count。

# 49. 架构责任总结

| **层拥有什么公式不拥有什么** |                                                              |                                                              |
| ---------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| `StateValue.js`              | HP、生存、能量、护盾、威胁、封印机会等非卡牌 state primitives | 卡牌资产、最终候选比较                                       |
| `CardValue.js`               | 卡牌/资源静态值、角色差量、保留/转移/弃牌 policy primitives  | World transition、最终 Utility                               |
| `Evaluator.js`               | 唯一 State/Card 聚合、Transition、END、Response、Search Prior、价值聚合与比较语义 | Simulator/Generator/Searcher 的状态构造                      |
| `Event/Probability`          | 概率、有限池、availability、来源匿名 bucket 的 identity slot probability、判定、range probability | 价值权重                                                     |
| `Domain Rules`               | 能量上限、能量获取、治疗量、座次等游戏规则事实               | AI value                                                     |
| `Searcher`                   | 搜索、sibling 完整性、候选集合、beam、budget 与 incumbent 维护；调用 Evaluator 获取价值结果 | State/Card 价值、sibling 价值聚合、END/Final Utility、最终偏好公式 |
| `Simulator`                  | `Action + World → World`                                     | AI value                                                     |
