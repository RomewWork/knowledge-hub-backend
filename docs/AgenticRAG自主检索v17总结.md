---
type: course-summary
status: done
course: 65
module: Agentic RAG 大模型自主检索
code_base:
  - ai-agent-code/knowledge/knowledge-hub-backend
  - ai-agent-code/knowledge/knowledge-hub-frontend
tags:
  - 课程总结
  - AgenticRAG
  - 意图路由
  - 切题评估
  - Agent
related:
  - "[[64-Mem0与Redis双层记忆]]"
  - "[[65-Agentic-RAG自主检索]]"
---

# Agentic RAG 大模型自主检索 v17 总结

> 课程 65 · 后端 `knowledge-hub-backend`（v17）· 前端 `knowledge-hub-frontend`（v17）
> 整理时间：2026-11-16

## 一句话

把「**代码先检索一次，模型只负责答**」升级成「**模型拿着检索工具自己决定**」：先判意图挂工具，检索后判切题，不切题就改写再查（最多两次），两次后仍不足才联网或明说没有。

## 与 v16 的差异

| 维度 | v16 | v17 |
|---|---|---|
| 控制权 | 代码编排（写死一次检索 + 一次改写） | **模型自主**（工具调用） |
| 检索结果可用性 | 有命中就全给模型 | **不切题一律不给** |
| 闲聊 | 靠 `needRetrieve` 跳过 | 意图路由 + **工具不挂载** |
| 联网 | 工具常驻 | 按意图动态挂载 |
| 过程可见性 | status / retrieve | + `data-intent`、`data-eval` |

## 五个意图

`ChatQueryRewriteService.classify()` → `ChatRoutePlan { intent, label, query, allowRetrieve, allowWeb }`

| intent | 中文 | allowRetrieve | allowWeb |
|---|---|---|---|
| `chitchat` | 闲聊 | ❌ | ❌ |
| `profile` | 个人偏好 | ❌ | ❌ |
| `kb` | 知识库 | ✅ | ❌ |
| `web` | 联网搜索 | ❌ | ✅ |
| `kb_then_web` | 知识库，不足则联网 | ✅ | ✅ |

**工具是"挂载"，不是"提示"**：闲聊那一轮 Agent 手里没有 `retrieve_knowledge`，模型想调也调不到。

prompt 里写的"易混"：

```
「我是哪个部门」        → profile（问的是用户自己）
「预算审核员属于哪个部门」→ kb（不要因为有"部门"就判 profile）
```

**失败兜底是 `kb`**：宁可多检索，不漏内部制度（修正 v16 的误判问题）。

## 三个原语：查 / 判 / 改

### ① 查 + 判：`retrieveAndGrade()`（`agentic-retrieve.ts`）

```ts
const rawHits = await retrieval.retrieve(usedQuery, topK, user);
const grade = await rewrite.gradeHits(question, rawHits);
return {
  rawHits,
  hits: grade.ok ? rawHits : [],   // ← 本讲最重要的一行
  grade, eval, usedQuery,
};
```

> **宁可让模型"没资料可说"，也不能给它错的资料**——模型会一本正经地用错制度回答。

### ② 判：`gradeHits()` 三态

| reason | 含义 | 是否调模型 |
|---|---|---|
| `empty` | 无命中 | ❌ 直接返回 |
| `relevant` | 能支撑作答 | ✅ |
| `irrelevant` | 词沾边但主题不同 | ✅ |

评估**失败时放行**（有召回就当切题）：评估器是增强，不能因为它抖一下误杀正确答案。

### ③ 改：`rewriteAfterRetrieve()`

```
输入：原问题 + 上次检索词 + 不足原因 + 上次命中（前 3 条）
输出：与上次不同的新词；相同或空 → 返回 ''（别再查了）
```

`distinctQuery()` 专门防"改写器把原词又吐回来"。

### `RetrieveEval.reason` 七种（给前端用）

```
ok / retried_ok                     切题（首轮 / 改写后）
empty / retried_empty               无命中
irrelevant / retried_irrelevant     有命中但不切题
error                               检索接口失败
```

## 流式：三个工具 + 双重上限

| 工具 | 挂载条件 | 作用 |
|---|---|---|
| `retrieve_knowledge` | `allowRetrieve` | 检索 + 评估 |
| `rewrite_query` | `allowRetrieve` | 换问法（依赖 `lastRetrieve`） |
| `web_search` | `allowWeb` | 联网兜底 |

**次数上限写两遍**：

| 层 | 手段 |
|---|---|
| prompt | "不要第三次 retrieve_knowledge" |
| **代码** | `if (retrieveCount >= 2) return { insufficient: true, error: ... }` |

> 凡是"次数/金额/长度"这类约束，永远不要只靠 prompt。

**`rewrite_query` 是有状态的**：

```ts
if (!lastRetrieve) return { error: '请先调用 retrieve_knowledge' };
if (lastRetrieve.eval.ok) return { error: '当前资料已切题，无需改写' };
```

## 一个隐蔽的坑：`invokeIsolated`

评估/改写/路由都是**结构化输出**，且发生在 **Agent 的流式上下文里**。不隔离的话，它们内部的 JSON token 会走同一套 callbacks → 混进 `messages` 流 → **变成回答正文**。

```ts
AsyncLocalStorageProviderSingleton.runWithConfig(
  { callbacks: [], tags: ['kh-internal'], metadata: { khInternal: true } },
  run,
  true,   // 不挂 tracing 根节点
);
```

前端还有第二道防线：`stripInternalToolJson()` 按 JSON 形状过滤（`{relevant,reason}`、`{query}`、`{intent,standalone_query}`）。

## 非流式：`retrieveUntilRelevant`

`/ai/chat`（JSON）没有 Agent 环，但**行为必须与流式一致**：

```
retrieveUntilRelevant()
  ├─ retrieveAndGrade（查 + 评估）
  ├─ onEval 回调
  ├─ 不切题 → rewriteAfterRetrieve → 再查一次
  └─ 返回 { hits, eval, usedQuery }
```

`ai-chat.service` 的"先库后网"就一行：

```ts
const web = plan.allowWeb && (!plan.allowRetrieve || kbInsufficient)
  ? await this.webSearch.search(searchQuery)
  : undefined;
```

`intent === 'kb' && kbInsufficient` → 直接返回"知识库里没有相关内容"，**不联网、不编造**。

## 前端：把"过程"做成可读轨迹

| 文件 | 改动 | 作用 |
|---|---|---|
| `ChatMessageParts.tsx` | +379/−57 | 轨迹时间线 + 意图/评估/检索/改写卡片 + 内部 JSON 过滤 |
| `ChatPage.tsx` | +119/−28 | 滚动钉底状态机 + 回到底部按钮 |
| `index.css` | +324/−42 | 竖线、节点圆点、三色状态、面板 |

### 轨迹结构

```
● 意图      知识库，不足则联网
│
● 知识库    正在检索…
│
● 评估      资料切题 / 不切题（含改写后的第二次）
│
● 改写      已换一种问法
│
● 联网      3 条结果
```

CSS 用 `.kh-trace::before` 画竖线、`.kh-trace-node` 画圆点，按 `intent/kb/eval.ok/eval.warn/eval.failed/rewrite/web` 染色。

### 去重

```ts
if (part.data.stage === 'intent' && hasIntent) return
```

后端同时发 `data-status{stage:'intent'}` 和 `data-intent`，两条都渲染会重复。

### 滚动钉底（v17 重写）

v15 之前是"每个 token 都 `scrollTop = scrollHeight`"，用户上滑看历史会被拽回底部。

```ts
pinBottomRef        // 是否钉在底部
autoScrollingRef    // 程序滚动期间忽略 onScroll（防误判）
gapToBottom(el)     // 距底距离
setPinned(next)     // 唯一开关入口
```

| 事件 | 行为 |
|---|---|
| `onScroll` | 距底 < 48px → 钉底；否则解锁 |
| `onWheel` | 向上立刻解锁；向下且接近底部钉回 |
| `onTouchMove` | 手指下移 > 6px 解锁 |
| 程序滚动 | `autoScrollingRef` 为真时 return |

`scrollRafRef` + `cancelAnimationFrame`：每帧最多滚一次，卸载时取消。

## 事件流全貌

```
start
data-session
data-status(intent)        正在识别意图…
data-intent                闲聊 / 知识库 / 联网搜索 / 知识库不足则联网
data-status(retrieve)      正在检索知识库…
data-eval                  切题 / 不切题（改写后还有一次）
[data-status(rewrite)]     正在换一种问法…
data-sources
source-document × N
text-delta …
finish
```

## 改动清单

**后端 5 文件 +990/−163**

| 文件 | 行数 | 性质 |
|---|---|---|
| `src/ai/agentic-retrieve.ts` | +181（新） | 检索+评估原语 |
| `src/ai/chat-query-rewrite.service.ts` | +276/−36 | 路由 + 评估 + 改写 |
| `src/ai/ai-stream.service.ts` | +306/−99 | 工具化 Agent 循环 |
| `src/ai/ai-chat.service.ts` | +74/−26 | 非流式对齐 |
| `src/ai/ai.controller.ts` | +5/−2 | 注释（语义变了） |

**前端 3 文件 +822/−127**：`ChatMessageParts.tsx`、`ChatPage.tsx`、`index.css`。

## 易错点

| 坑 | 说明 |
|---|---|
| 只靠 prompt 限次数 | 必须有代码兜底 `retrieveCount` |
| 不切题照给模型 | 会用错制度回答，比"没有"更糟 |
| 引用编号不累加 | 第二轮又从 `[1]` 开始 → 前端串号 |
| 内部调用不隔离 | 评估 JSON 混进回答正文 |
| `rewrite_query` 在 ok 后仍可用 | 必须判 `eval.ok` |
| 工具全量挂载 | 闲聊也可能触发检索 |
| 评估失败就拒答 | 应放行（有召回即用） |
| `kb_then_web` 直接联网 | 必须库先不足 |
| `ok` 当成"有命中" | 它表示"能作为制度依据" |
| 分类失败按 chitchat | 应默认 kb（宁多检不漏） |

## 验收（照 `agentic-rag.md` 的 24 组，最小 5 条）

| # | 输入 | 期望 |
|---|---|---|
| 1 | 你好 | 意图「闲聊」，无检索卡 |
| 2 | 出差预估费用超过五千谁还要加签？ | 知识库 + 评估切题，引用差旅办法 |
| 3 | 加班餐补怎么报、标准是多少？ | 词沾边不切题 → **改写再查** → 仍没有就说没有 |
| 4 | 公司年会抽奖规则是什么？ | 库空 → 改写一次 → 明确没有，**禁止编造** |
| 5 | 今天人民币兑美元汇率 | 意图「联网搜索」，出联网卡 |

补充关键条目：
- 「我是哪个部门」→ profile；「预算审核员属于哪个部门」→ **必须 kb**
- 「那这个找谁」→ 钉在上一轮主题（指代改写）
- 「我们请假制度和今年国务院放假安排有什么关系」→ `kb_then_web`，先库后网

## 主动回忆

1. **Agentic RAG 和固定 RAG 的本质区别？**
   固定 RAG 是"检索一次 → 拼 prompt → 答"；Agentic RAG 把检索变成**工具**，由模型决定查不查、查几次、换不换问法，并在中间插入"切题评估"这道闸门。

2. **为什么"不切题的命中"要清空而不是交给模型判断？**
   模型看到资料就会用。给它错资料，它一定拿来答；不给，它才会说"没有"。**错误资料比没有资料更危险**。

3. **为什么次数限制既写 prompt 又写代码？**
   prompt 是软约束，模型可能不遵守；代码（`retrieveCount`）是硬兜底。约束类需求永远双保险。

4. **`invokeIsolated` 解决什么故障？**
   工具内部再调模型（评估/改写）时，结构化输出的 token 会走同一套 callbacks，混进 messages 流变成回答正文；隔离后内部调用不再产生对外事件。

5. **`kb_then_web` 和 `web` 的差别体现在哪行代码？**
   ```ts
   plan.allowWeb && (!plan.allowRetrieve || kbInsufficient)
   ```
   `web` 不查库（`!allowRetrieve` 为真）直接联网；`kb_then_web` 必须库先不足。

## 关联

- [[65-Agentic-RAG自主检索]] —— 课程精读
- [[64-Mem0与Redis双层记忆]] —— 上一讲
- 前一篇：`docs/Mem0与Redis双层记忆v16总结.md`
