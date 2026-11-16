---
type: course-summary
status: done
course: 67
module: 基于 LangFuse 的 Agent 评测与 Tracing
code_base: ai-agent-code/knowledge/knowledge-hub-backend
tags:
  - 课程总结
  - Langfuse
  - 可观测性
  - 评测
  - OpenTelemetry
related:
  - "[[66-Graph-RAG知识图谱进RAG]]"
  - "[[67-LangFuse评测与Tracing]]"
---

# 基于 LangFuse 的 Agent 评测与 Tracing v19 总结

> 课程 67 · 后端 `knowledge-hub-backend`（v19）· 本讲纯后端
> 整理时间：2026-11-16

## 一句话

给 Agent 装两只眼睛：**线上 tracing**（每次问答的意图/工具/检索/评估都上报 Langfuse）+ **线下评测**（9 条金标跑同一套 Agent，输出可对比的分数）。

## 两条链路

```
线上：HTTP → streamChat → Agent → OTel span → Langfuse Trace 面板
线下：golden-dataset → runForEval → ChatEvalSnapshot → evaluators → Scores → Experiment
```

**共用同一个入口 `runForEval()`**——评测跑的是线上同一份 Agent 代码，不是另写一套。

## 代码地图（V19）

| 文件 | 行数 | 角色 |
|---|---:|---|
| `src/observability/langfuse.ts` | 61（新） | tracing 开关 + span 包装 |
| `src/ai/eval/eval.types.ts` | 63（新） | 快照 / 金标类型 |
| `src/ai/eval/golden-dataset.ts` | 116（新） | 9 条金标 |
| `src/ai/eval/evaluators.ts` | 395（新） | 9 个评分器 |
| `src/ai/eval/run-experiment.ts` | 95（新） | 评测入口 |
| `src/ai/agentic-retrieve.ts` | +85 | 包 span + 返回评测字段 |
| `src/ai/chat-query-rewrite.service.ts` | +178 | 产出改写信息 |
| `src/ai/ai-chat.service.ts` | +125 | `includeEval` 快照 |
| `src/ai/ai-stream.service.ts` | +176 | `runForEval()` |

## ① tracing：可开关

```ts
export function isLangfuseEnabled() {
  return Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);
}

export function startLangfuseTracing() {
  if (sdk || !isLangfuseEnabled()) return;
  sdk = new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] });
  sdk.start();
}

export async function withObservation(name, run) {
  if (!isLangfuseEnabled()) return run(() => undefined);   // ← 零成本降级
  return startActiveObservation(name, async (span) => run((f) => span.update(f)));
}
```

**关键设计**：

| 设计 | 为什么 |
|---|---|
| `isLangfuseEnabled()` 总开关 | 观测能力不能成为业务依赖，没配 Key 必须能跑 |
| `withObservation` 无 Key 直接执行 | 业务代码不需要写 `if (enabled)` |
| `shutdownLangfuseTracing` | 不 flush 会丢最后一批上报 |
| `withTraceAttrs({userId, sessionId, tags})` | 让 trace 能按用户/会话筛 |

`main.ts` 里三行接线：

```ts
startLangfuseTracing();
app.enableShutdownHooks();
process.once('beforeExit', () => { void shutdownLangfuseTracing(); });
```

## ② 评测快照：记"实际发生了什么"

```ts
ChatEvalSnapshot {
  question, answer, intent,
  allowRetrieve, allowGraph, allowWeb,    // 允许
  retrieveCount, rewritten, retryQuery,   // 实际 ← 关键
  graphUsed, webUsed,
  rawHits,        // rerank 后、切题过滤前 → 测召回
  gradedHits,     // 喂给模型的 → 测忠实度
  webSnippet,
}
```

**两组字段的区分是整讲的骨架**：

| 区分 | 用途 |
|---|---|
| `allow*` vs `*Used` | 护栏看实际调用，不是"允许调用" |
| `rawHits` vs `gradedHits` | 前者衡量检索层，后者衡量生成层 |

混在一起就无法回答"是没检索到，还是检索到了没用"。

## ③ 金标数据集：9 条，按 suite 分组

| suite | 用例 | 考什么 |
|---|---|---|
| `routing` | 你好 / 预算审核员属于哪个部门 | 意图分类（后者最易误判 profile） |
| `kb-hit` | 差旅加签 / VPN 账号 / 灰度窗口 | 检索到 + 答对要点 |
| `rewrite` | 加班餐补 | 不切题必须改写 |
| `kb-empty` | 年会抽奖 / 实习生转正 | 必须拒答，不能编 |
| `web` | 人民币汇率 | 走联网 |

两个设计约束：

```ts
relevantDocTitles: ['差旅']     // 标题子串，不用 documentId（本地/CI 的 ID 会变）
relevantDocTitles: []           // 空数组 = 库里没有该制度，用来算 false_hit
```

## ④ 9 个评分器

### 确定性（能算的绝不用模型）

| 指标 | 判据 |
|---|---|
| `intent_match` | 实际 intent == 金标 intent |
| `tool_policy` | 护栏：`forbidRetrieve` 却检索了 → 0 分 |
| `rewrite_loop` | 首轮不足后是否改写，且新词 ≠ 旧词 |
| `hit_at_5` | rerank 后 Top-5 是否出现金标文档（切题过滤前） |
| `precision_at_5` | Top-5 里标题对得上金标的比例 |
| `false_hit` | 题库空时不该把任何文档当切题 |

### LLM judge（只有语义判断才调模型）

| 指标 | 判据 |
|---|---|
| `refusal_quality` | 拒答是"承认没有"还是"编了一个" |
| `completeness` | `keyPoints` 覆盖 + `mustNotContain` 不含 |
| `groundedness` | 答案每句能否被 `gradedHits` 支撑 |

**`value: null` 的含义**：本题跳过（没有金标），**不写入 Langfuse**——否则会被平均成 0 分，指标失真。

## ⑤ 评测入口

```ts
if (isLangfuseEnabled()) {
  const result = await langfuse.experiment.run({
    name: 'agentic-rag',
    data, task, evaluators: AGENT_EVALUATORS,
    maxConcurrency: Number(process.env.EVAL_CONCURRENCY ?? 2),
  });
  console.log(await result.format());
  await langfuse.flush();
} else {
  // 无 Key：终端逐条打印分数
}
```

两个必须：

```ts
function evalUser(): AuthUser {
  return { userId: EVAL_USER_ID || 'eval-admin', roles: [RoleCode.ADMIN], ... };
}
```

- **必须用管理员**：否则行级权限会把公开制度也过滤掉，评测结果全空；
- **必须 flush**：进程退出前不 flush 会丢上报。

## ⑥ 修改的文件：为了拿到数据

### `agentic-retrieve`

```ts
return withObservation('retrieve-and-grade', async (update) => {
  const rawHits = await retrieval.retrieve(...);
  const grade = await rewrite.gradeHits(question, rawHits);
  update({ query: usedQuery, ok: grade.ok, rawHits: rawHits.length });
  ...
});
```

"一次检索 + 一次评估"= 一个 span。这样 trace 里能看到**为什么判不切题**，而不是只看到最终答案。

### `ai-stream.runForEval`

```ts
async runForEval(question, topK, user): Promise<ChatEvalSnapshot> {
  const plan = await this.queryRewrite.classify(question, []);
  const trace: AgentEvalTrace = { retrieves: [], graphUsed: false, webSnippets: [] };
  const agent = this.createTurnAgent(user, topK, [], silentWriter(), plan, question, trace);
}
```

同时做到三件事：

1. `silentWriter()`：不推前端事件，但**复用同一套工具**；
2. `AgentEvalTrace`：工具内部收集每次检索的 hits、是否用图/网；
3. **不碰会话、不写记忆**：评测不污染用户数据。

### `ai-chat.includeEval`

```ts
if (includeEval) result.eval = snapshot;   // 默认不返回，避免响应变大
```

## ⑦ 指标为什么分三层

```
路由层   intent_match / tool_policy / rewrite_loop
检索层   hit_at_5 / precision_at_5 / false_hit
生成层   completeness / groundedness / refusal_quality
```

**分层的价值是定位**：

| 现象 | 结论 |
|---|---|
| `intent_match` 掉 | 路由 prompt 被改坏 |
| `hit_at_5` 正常、`groundedness` 掉 | 检索没问题，生成不按资料答 |
| 两者一起掉 | 检索/索引问题（如 IK 分词） |
| `false_hit` 变高 | 切题评估太宽松 |

## 实战踩坑

### 坑 1：`@langfuse/client` 5.14 类型变更

```ts
type ExperimentItem<Input, Expected, Meta> =
  | { input?: Input; expectedOutput?: Expected; metadata?: Meta }
  | DatasetItem;        // 新增联合分支，input 是 unknown
```

两个冲突：

- `input` 由必填变**可选** → `GoldenItem` 的函数签名不兼容；
- 联合类型里 `DatasetItem.input` 是 `unknown` → 读 `.question` 报 `Property does not exist on type '{}'`。

修法：显式标注 `ExperimentTask<…>`，函数内把参数收窄：

```ts
const task: ExperimentTask<{ question: string }, GoldenExpected, { id: string; suite: string }> =
  async (raw) => {
    const item = raw as { input?: { question?: string }; metadata?: { id?: string } };
    const question = item.input?.question ?? '';
    ...
  };
```

### 坑 2：评测用户不是 admin

行级权限会过滤掉一切，表现为"评测全 0 分"，很容易误判成检索坏了。

### 坑 3：`runForEval` 落了库

会污染会话和 Mem0 记忆；课程实现里刻意不传 writer、不调 appendTurn。

### 坑 4：评测依赖真实索引

文档没发布、`kh_chunk` 没重建（比如缺 IK 分词），评测全是 0 分——**先确认索引再评测**。

## 改动清单

| 文件 | 内容 |
|---|---|
| `package.json` | +6 依赖（`@langfuse/*`、`@opentelemetry/*`）+ `eval:rag` 脚本 |
| `.env` | `LANGFUSE_*` / `EVAL_*` |
| `main.ts` | 启动 tracing + shutdown hooks |
| 9 个源码文件 | 见代码地图 |

## 易错点

| 坑 | 说明 |
|---|---|
| 没配 Key 就崩 | 必须降级为空跑 |
| 忘 `flush()` | 丢上报 |
| 评测并发太高 | 撞模型限流，默认 2 |
| 跳过题算 0 分 | `value: null` 不写入 |
| 只用 LLM judge | 确定性指标更便宜、更稳定 |
| 只看平均分 | 定位不到瓶颈，要点进 trace |
| 评测用户权限不足 | 结果全空 |
| 评测污染会话/记忆 | `runForEval` 必须隔离 |
| 数据集用 documentId | 本地/CI 会变，用标题子串 |
| 版本漂移 | `@langfuse/client` 5.13→5.14 类型就变了 |

## 主动回忆

1. **为什么观测必须可关闭？**
   观测是"增强"，不能成为业务前置条件。没配 Key 时 `withObservation` 直接执行 `run`，业务零感知。

2. **`rawHits` 与 `gradedHits` 的区别，各自衡量什么？**
   `rawHits` 是 rerank 后、切题过滤前的候选 → 衡量**检索层**（hit@5、precision@5）；`gradedHits` 是最终喂给模型的 → 衡量**生成层**（groundedness）。混用就无法定位"没检索到"还是"检索到了没用"。

3. **为什么确定性指标优先于 LLM judge？**
   便宜、稳定、可复现；只有"要点覆盖/忠实度"这类语义判断才需要 judge。

4. **`value: null` 和 `value: 0` 有什么区别？**
   `null` = 本题跳过（没有金标），不写入 Langfuse；`0` = 真的失败。合并会让平均分失真。

5. **评测分数掉了，你的排查顺序？**
   先看 `intent_match`（路由）→ 再看 `hit_at_5`（检索）→ 最后 `groundedness`（生成）；同时确认索引状态和评测用户权限。

## 关联

- [[67-LangFuse评测与Tracing]] —— 课程精读
- [[66-Graph-RAG知识图谱进RAG]] —— 上一讲
- 前一篇：`docs/GraphRAG知识图谱进RAGv18总结.md`
