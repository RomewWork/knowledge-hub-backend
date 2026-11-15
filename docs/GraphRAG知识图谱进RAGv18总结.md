---
type: course-summary
status: done
course: 66
module: Graph RAG 知识图谱进 RAG
code_base:
  - ai-agent-code/knowledge/knowledge-hub-backend
  - ai-agent-code/knowledge/knowledge-hub-frontend
tags:
  - 课程总结
  - GraphRAG
  - Neo4j
  - AgenticRAG
related:
  - "[[65-Agentic-RAG自主检索]]"
  - "[[66-Graph-RAG知识图谱进RAG]]"
---

# Graph RAG 知识图谱进 RAG v18 总结

> 课程 66 · 后端 `knowledge-hub-backend`（v18）· 前端 `knowledge-hub-frontend`（v18）
> 整理时间：2026-11-16

## 一句话

给 Agent 多加一件工具：`retrieve_graph` 与 `retrieve_knowledge` **并行挂载**，用图谱回答"谁和谁有关系"，用 chunk 回答"制度怎么写的"；图谱结果只当**关系线索**，制度事实仍以检索原文为准。

## 为什么需要图谱

| 问题 | 靠谁 |
|---|---|
| 制度怎么写、条文是什么 | `retrieve_knowledge`（chunk 有原句，可引用 `[n]`） |
| 谁审批、A 与 B 怎么连、岗位归属哪条流程 | `retrieve_graph`（关系跨文档，chunk 拼不出链路） |
| 今天的汇率、最新公告 | `web_search` |
| 闲聊、改自己的偏好 | 不挂工具 |

**定位对比（很重要）**：

| | v17 联网 | v18 图谱 |
|---|---|---|
| 角色 | **兜底**（知识库不足才用） | **补充**（与知识库并行） |
| 挂载 | `web` / `kb_then_web` | `kb` / `kb_then_web` |
| 时机 | 库走完之后 | **第一轮就并行** |

> 如果图谱只在"知识库失败后"才查，它永远拿不到"第一视角"，价值减半。

## 三层改动

```
路由层：额外产出 graph_queries（短实体名）
   ↓
检索层：retrieveForChat —— 实体匹配 → 关系 → 来源文档
   ↓
上下文层：formatGraphSystemText —— 注入 system，带免责声明
```

## ① 路由层：为什么单独要一组短实体名

```ts
graph_queries: z.array(z.string()).describe('图谱短实体名：2～6 个、每个 2～8 字')
```

prompt 约束：

```
- 只在 kb / kb_then_web 填写，其他意图必须空数组
- 每个词 2～4 个字的实体短名（人/岗/制度对象），不要整句、不要问号
- 必须拆开：发票如何报销 → 发票、报销
- 禁止：流程、要求、办法、如何、怎么、什么、是什么
```

| 为什么 | 说明 |
|---|---|
| 不能用整句 | 图谱实体名是抽取出的短词，整句一个都对不上 |
| 禁止虚词 | "流程/办法"这类词在图里大量存在，会"什么都匹配到" |
| 必须拆开 | 一个实体词对应一个节点，复合词匹配不到 |

`allowGraph = kb`（kb / kb_then_web 才为 true）。

## ② 检索层：`retrieveForChat`

### 实体匹配：刻意**不用** `CONTAINS`

```cypher
MATCH (e:KnowledgeEntity)
WHERE any(kw IN $kws WHERE
  toLower(e.name) = toLower(kw)                                     // 全名相等
  OR toLower(replace(replace(e.name,'《',''),'》')) STARTS WITH toLower(kw)   // 去书名号后前缀
  OR toLower(e.name) ENDS WITH toLower(kw)                          // 后缀
  OR any(a IN coalesce(e.aliases,[]) WHERE ...同规则...)            // 别名
)
```

代码注释直接写明：

> **只做相等 / 前缀 / 后缀，避免「发票」`CONTAINS` 命中整篇制度标题。**

`CONTAINS` 看似召回更多，实际把《差旅与费用报销管理办法（2026 版）》这类长标题全捞进来，图谱卡退化成标题列表。

### 排序：三档 + 短名优先

```cypher
ORDER BY
  CASE WHEN 全名相等 THEN 0
       WHEN 前缀/后缀 THEN 1
       ELSE 2            // 靠别名命中
  END,
  size(e.name)           // 同档取更短的名字
```

"差旅报销" 与 "差旅与费用报销管理办法（2026 版）" 都前缀命中，但只有前者是真正的实体。

### 可见性：实体没有权限，文档才有

```cypher
AND ($unrestricted OR EXISTS {
  MATCH (d:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(e)
  WHERE d.authorId = $accessUserId OR d.isPublic = true OR d.teamId IN $accessTeamIds
})
```

必须沿 `文档 → 块 → 实体` 反向判断——不然会通过关系泄露无权文档的实体。

### 关系：只取命中实体**之间**的边

```cypher
MATCH (a:KnowledgeEntity)-[r:RELATED_TO]->(b:KnowledgeEntity)
WHERE a.name IN $names AND b.name IN $names
RETURN a.name, coalesce(nullif(r.relation,'RELATED_TO'),'关联'), b.name
```

**不要扩邻居**：扩两跳就能把整个图捞出来，上下文爆炸且大多无关。

### 来源文档

```cypher
MATCH (d:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(e)
WHERE e.name IN $names AND (...可见性...)
RETURN DISTINCT d.id, d.title LIMIT 8
```

### 一个易踩的实现细节

`session` 是**顺序执行**的（实体 → 关系 → 文档共用同一个 session）。Neo4j 的 session 不是线程安全的连接池，同一 session 并发查询会丢边。

## ③ 上下文层：两个格式化函数

```ts
formatGraphContext(hit)      // 关系列表 或 实体名 + 来源文档
formatGraphSystemText(hit)   // 包【本轮知识图谱】+ 免责声明
```

注入长这样：

```
【本轮知识图谱】
关系：
- 发票 → 报销（属于）
- 报销 → 差旅（关联）
来源文档：差旅与费用报销管理办法（2026 版）

以上只说明实体之间的关系，不能当制度原文；制度/流程以知识库检索资料为准。
```

**最后那句是能否上生产的分水岭**：图谱是 LLM 抽取的，有损、会串错；一旦被当制度原文，模型会编出"金额 500 元"——而图里根本没有金额。

## Agent 层：`retrieve_graph` 工具

```ts
if (plan.allowGraph) {
  tools.push(tool(async ({ query }) => {
    const keywords = [...plan.graphQueries, ...(query ? [query.trim()] : [])];
    const hit = await graph.retrieveForChat(keywords, 8, accessFromUser(user));
    writer.write({ type: 'data-graph', data: hit });
    return { ...hit, context: formatGraphContext(hit),
             insufficient: !hit.entities.length && !hit.relations.length };
  }, { name: 'retrieve_graph', schema: z.object({ query: z.string().min(1) }) }));
}
```

**三个要点**：条件挂载、权限入参、空结果标记 `insufficient`。

### 必须并行：两个前提

1. **prompt 声明**（软约束）：

```
第一步必须在同一次回复里并行调用 retrieve_knowledge 和 retrieve_graph，两个都要调：
retrieve_graph 的 query 必须是短实体名（空格或 / 分隔），不要整句。
```

2. **LLM 配置允许并行**（硬条件）：

```ts
modelKwargs: {
  ...(enableThinking ? { enable_thinking: true } : {}),
  parallel_tool_calls: true,   // 少这一行，模型会串行发工具
}
```

工具描述里也要写："首次必须与 retrieve_graph 在同一次并行调用。"

## 非流式：有图谱就不拒答

```ts
const [retrieved, graphHit] = await Promise.all([kbP, graphP]);
const hasGraph = Boolean(graphHit?.entities.length || graphHit?.relations.length);
if (plan.intent === 'kb' && kbInsufficient && !hasGraph) return '知识库里没有相关内容。';
```

v17 是"知识库不足就拒答"，v18 加了 `!hasGraph`：图谱可能给出"这属于差旅制度范畴"的线索，比一句"没有"有用。

## 前端：复用 ForceGraph 画对话内的图

| 文件 | 改动 |
|---|---|
| `ChatMessageParts.tsx` | +188：`GraphHit` 类型、`data-graph` → `GraphCard`、`GraphToolCard` |
| `ForceGraph.tsx` | +177：`compact` 模式、`graphDataKey`、`symbolSize(node, degree, scale)` |
| `index.css` | +67：图谱卡片样式 |
| `ChatPage.tsx` | 文案改为"按需检索知识库、图谱或联网" |

### 三个关键点

**① `compact` 模式**：图谱页是全屏，对话里只有 ~260px。同一份数据要两套布局参数（斥力、边距、字号），所以 ForceGraph 改成可配置，而不是复制一份。

**② `layoutAnimation: true`（从 false 改回来）**

```diff
- layoutAnimation: false, // 关掉入场动画，大数据更稳
+ // layoutAnimation 必须开，关掉节点会叠在原点只剩箭头空转
+ layoutAnimation: true,
```

力导向是迭代求解，关掉动画 ECharts 不跑迭代 → 所有节点停在原点。

**③ 避免双卡**：后端同时发 `data-graph` 与 `tool-retrieve_graph`，前端只渲染其中一个。

## 改动清单

**后端 6 文件 +379/−44**

| 文件 | 行数 | 内容 |
|---|---|---|
| `src/pipeline/graph-build.service.ts` | +226 | `retrieveForChat` + 三个格式化/合并函数 |
| `src/ai/ai-stream.service.ts` | +103 | `retrieve_graph` 工具、并行 prompt、`data-graph` |
| `src/ai/ai-chat.service.ts` | +47 | 并行检索、`hasGraph`、system 注入 |
| `src/ai/chat-query-rewrite.service.ts` | +39 | `graph_queries` schema + prompt + `allowGraph` |
| `agentic-rag.md` | +6 | 自测题更新（图谱参与对话） |
| `docker-compose.yml` | 2 | Neo4j 版本固定 `2026.04.0`（避免 `latest` 漂移） |

**前端 4 文件 +369/−65**。

## 实战踩坑记录

### 坑 A：`parallel_tool_calls` 缺失 → 工具串行

现象：知识库查一次（红）→ 图谱查一次（红）→ 再补一次（蓝），一张图出现两个卡片。

根因：`modelKwargs` 里没有 `parallel_tool_calls: true`，模型一次只发一个工具；加上 prompt 里缺"首次必须并行"的描述，模型更没有动机并行。

修复：补 `parallel_tool_calls: true` + 补工具描述。

### 坑 B：工具事件被推两遍 → 前端出现"红色空卡"

抓包统计（一次问答）：

```
tool-input-start  x4      ← 只有 2 个 toolCallId
tool-output-available x4
data-eval  x1             ← 真实只有一次检索
data-graph x1             ← 真实只有一次图谱检索
reasoning-start x2        ← 两个模型步骤，正常
```

同一个 `toolCallId` 的 `tool-input-start` 发了两次 → 前端把重复的那份渲染成"未检索到相关资料"（红），另一份有输出（蓝）。

根因：`@ai-sdk/langchain` 的 `toUIMessageStream` 在 `streamMode: ['messages','tools']` 下重复推送工具事件；用户项目依赖版本比课程新（`ai@7.0.166` vs `7.0.93`）。

两种修法：
- **前端按 `toolCallId` 去重**（保留有 output 的那份）——防御性，推荐；
- **锁定依赖版本**到课程版本。

### 坑 C：`layoutAnimation: false` 导致节点全叠在原点

看似性能优化，实际破坏力导向迭代。

## 易错点

| 坑 | 说明 |
|---|---|
| 整句查图谱 | 实体名是短词，整句匹配不上 |
| `CONTAINS` 匹配实体 | 命中整篇标题，图谱卡变成标题列表 |
| 把图谱当制度原文 | 抽取有损，必须带免责声明 |
| 扩邻居节点 | 两跳捞出全图，上下文爆炸 |
| 并发共用 Neo4j session | 会丢边，必须顺序 `run` |
| 图谱空结果就中断 | 应显示"图谱中没有匹配实体"，问答继续 |
| 等知识库切题才查图 | 图谱永远只能兜底，价值减半 |
| 忘配 `parallel_tool_calls` | 工具串行，首轮延迟翻倍 |
| `layoutAnimation: false` | 节点全叠原点 |
| 双卡渲染 | `data-graph` 与 `tool-retrieve_graph` 只渲染一个 |
| 图谱实体不做权限过滤 | 通过关系泄露无权文档 |

## 验收（`agentic-rag.md` 已更新）

过程条顺序变为：**意图 → 图谱 → 知识库 → 评估 → 改写 → 再检索 → 联网**。

| 检查点 | 期望 |
|---|---|
| 知识库类问题 | 意图卡"图谱"为开，随后出现图谱卡 |
| 图谱无匹配 | 卡片写"图谱中没有匹配实体"，问答继续 |
| 闲聊 / 偏好 / 纯联网 | 不出现图谱卡与知识库卡 |
| 制度类回答 | `[n]` 仍指向知识库文档，不是图谱 |
| Neo4j 未启动 | 只 warn，问答不中断 |
| 首轮 | 知识库与图谱**同时**出现（并行） |

后端日志参考：

```
图谱对话检索：kws=发票/报销 entities=4 rels=2
混合检索 RRF：keyword=11, vector=17, fused=17
Rerank 完成：model=qwen3-rerank, in=17, out=17
检索过滤：rerank=17, minScore=0.4, best=0.696, kept=2, return=2
检索评估：切题 ...
```

## 主动回忆

1. **为什么图谱不能用 `CONTAINS` 匹配实体？**
   实体的 `name` 里有大量长标题（《差旅与费用报销管理办法》），`CONTAINS '发票'` 会把它们全命中，图谱卡退化成文档标题列表；应做**相等 / 前缀 / 后缀**三层匹配。

2. **图谱检索的权限怎么过滤？**
   实体本身没有权限，权限来自它出现的文档：`(d)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(e)`，再对 `d` 用 `neo4jDocumentAccessWhere`。

3. **为什么图谱要与知识库并行而不是兜底？**
   图谱提供"关系视角"，若只在库失败后才查，它永远拿不到第一视角；并行还能省一次 RTT。

4. **`formatGraphSystemText` 结尾那句免责声明为什么必须？**
   图谱是 LLM 抽取的，有损且可能串错；不声明就会被当制度原文，模型据此编造金额、时限。

5. **只配 prompt 说"必须并行"够不够？**
   不够。还要 `modelKwargs.parallel_tool_calls: true`，否则模型根本不具备一次发多个工具的能力。

## 关联

- [[66-Graph-RAG知识图谱进RAG]] —— 课程精读
- [[65-Agentic-RAG自主检索]] —— 上一讲
- 前一篇：`docs/AgenticRAG自主检索v17总结.md`
