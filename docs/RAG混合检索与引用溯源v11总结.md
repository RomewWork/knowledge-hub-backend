---
type: course-summary
status: done
course: 59
module: RAG 混合检索与引用溯源
code_base: ai-agent-code/knowledge/knowledge-hub-backend
tags:
  - 课程总结
  - RAG
  - 混合检索
  - RRF
  - Rerank
  - 引用溯源
related:
  - "[[58-关键词高亮与图谱检索]]"
  - "[[59-RAG混合检索与引用溯源]]"
---

# RAG 混合检索与引用溯源 v11 总结

> 课程 59 · 代码基线 `ai-agent-code/knowledge/knowledge-hub-backend`（v11）
> 整理时间：2026-11-05

## 一句话

**把「向量召回」升级成「关键词 + 向量双路召回 → RRF 融合 → reranker 精排 → 带编号引用的生成」**，并让返回的 sources 只包含答案里真正引用到的资料。

## 两个接口

| 接口 | 入参 | 行为 | 权限 |
|---|---|---|---|
| `POST /rag/search` | `{ query, topK? }` | 只检索，不调 LLM，返回 `ChunkHit[]` | `search` |
| `POST /ai/chat` | `{ content, topK? }` | 检索 + 生成，返回 `{ answer, sources }` | `search` |

> 控制器是 `@Controller()`（无前缀），所以路径就是 `/rag/search`、`/ai/chat`。写成 `@Controller('ai')` 会变成 `/ai/rag/search`。

## 检索链路

```
query
 ├─ keywordSearch: multi_match(document_title^2, content, ik_smart) → top20
 └─ knnSearch:     ES knn(embedding, cosine, num_candidates=k*10)   → top20
        ↓  Promise.all 并行两次 ES 请求
   rrfFuse：按 chunkId 去重，score += 1/(rrfC + rank + 1)
        ↓
   rerank：DashScope text-rerank，对候选逐条打相关分
        ↓
   slice(0, topK)
```

**注意**：融合在**应用层**做（两次独立 ES 请求），不是 ES 原生 hybrid；链路里**没有 minScore 阈值**。

## RRF 实现要点

```ts
const rrf = 1 / (rrfC + rank + 1);   // rrfC 默认 60
// 同一 chunkId 在两路都出现 → existing.score += rrf
// 最后按 score 降序
```

- 只用**名次**，绕开「BM25 分无上界、余弦分 0~1」量纲不可比的问题；
- 两路都命中的块天然排前（分数叠加）；
- `rrfC` 越大，名次差异被压得越平（`RAG_RRF_C` 可调）。

## Reranker

```ts
POST {RERANK_BASE_URL}/api/v1/services/rerank/text-rerank/text-rerank
body: { model, input: { query, documents }, parameters: { return_documents: false, top_n } }
```

- 直接用 `fetch`，不引 SDK；
- `toDocument` 拼 `标题 + heading + 正文`，**每条截断 2000 字**；
- `isEnabled()` = 开关开 && 有 Key；
- **失败一律返回 `null`，从不抛错**，由上层降级。

## 三层降级

| 失败点 | 行为 |
|---|---|
| embedding 失败 | `queryVector=null` → 只走关键词 |
| rerank 未配置 / 调用失败 / 返回空 | 返回 `null` → 用 RRF 顺序 |
| ES 不可用 | 两路都返回 `[]` → 整体空结果（不 500） |

## 引用溯源

```
① buildContext：`[n] 标题 / 章节\n正文`（每块截 800 字）
② system prompt 契约：
   - 只依据检索到的资料回答
   - 资料不足就说不知道，不许编造
   - 依据某条资料的陈述必须在句末标注 [1]、[2]
   - 编号必须与资料列表一致，不许标未使用的编号、不许编造标题/链接
③ toCitedSources：
   - 正则 /\[(\d+)\]/g 抽取回答里出现的编号（过滤越界）
   - 有引用 → 只返回被引用的，按编号升序
   - 无引用 → 回退返回全部召回（防止模型不听话时前端空列表）
④ excerpt：每条只给 200 字摘录，不回吐整块正文
```

`ChatSource.index` 就是回答里 `[n]` 的 n，前端据此做「点击跳原文」。

## 数据结构

```ts
interface ChunkHit {
  chunkId; documentId; documentTitle; content; heading;
  score: number;              // 当前阶段得分：原始 / RRF / rerank
  bm25Score?; vectorScore?;   // 两路原始分，便于调参
}

interface ChatSource {
  index; documentId; documentTitle; heading; excerpt; score;
}
```

**一个 `score` 贯穿三个阶段**：RRF 阶段是名次分，rerank 后是相关性分，前端只按它排序。

## 改动清单

| 文件 | 改动 |
|---|---|
| `src/ai/ai.module.ts` | 新增模块，import `PipelineModule` |
| `src/ai/ai.controller.ts` | 新增两个接口 |
| `src/ai/dto/chat.dto.ts`、`rag-search.dto.ts` | `topK` 上限 10 / 20 |
| `src/ai/hybrid-retrieval.service.ts` | 新增：编排双路召回 + 精排 + 降级 |
| `src/ai/reranker.service.ts` | 新增：DashScope text-rerank 调用 |
| `src/ai/ai-chat.service.ts` | 新增：生成 + 引用解析 |
| `src/pipeline/vector-index.service.ts` | +181 行：`keywordSearch` / `knnSearch` / `searchHybrid` / `rrfFuse` |
| `src/pipeline/types/pipeline.types.ts` | 新增 `ChunkHit` |
| `src/pipeline/search-index.service.ts` | **移除**「索引未配 IK 则删重建」逻辑，改为存在即复用 |
| `.env.example` | 新增 `RAG_HYBRID_TOP_K` / `RAG_RRF_C` / `RAG_RERANK_*` / `AI_CHAT_TIMEOUT_MS` |

## 关键设计

1. **双路互补**：向量补语义改写，BM25 补专有名词/型号/人名。
2. **RRF 而非加权求和**：分数量纲不同，归一化对分布敏感；名次融合简单稳健。
3. **精排只跑候选**：20 条候选做 cross-encoder，成本可控；全库跑不可行。
4. **降级优先于报错**：任何一环失败都不让问答整体 500。
5. **引用以模型实际引用为准**：避免「sources 列了 5 条、答案只用了 1 条」的假溯源。
6. **检索与生成分离**：`/rag/search` 不烧 token，调参只看它。

## 易错点

| 坑 | 说明 |
|---|---|
| **`kh_chunk.content` 未显式配 IK** | 代码里 mapping 是 `content: { type: 'text' }`（默认 standard），而查询用 `analyzer: 'ik_smart'`；索引侧若也没配 IK，中文关键词召回会明显偏弱。`kh_document` 才配了 `ik_max_word`，两处不一致 |
| 索引已存在时不校验 mapping | `createIndexIfNotExists` 直接 `if (exists) return`，历史索引分词错误会**静默沿用** |
| `search-index.service` 也移除了删重建 | 同理，`kh_document` 若历史上没配 IK 也不会自愈，需手工删索引 |
| 向量维度写死在 mapping | 换 embedding 模型必须删索引重建（`dims` 不匹配会写入失败） |
| `num_candidates` 太小 | 代码用 `max(k*10, 50)`，预取不足会导致 kNN 凑不够数 |
| rerank 的 `top_n` | 已 `Math.min(topN, candidates.length)`，自己写时别漏 |
| 模型不标编号 | 代码回退返回全部召回，前端会看到 5 条而非 2 条——这是「防空洞」不是「精确」 |
| 两个接口混用 | `/rag/search` 不调模型；拿它当聊天接口会以为"怎么不回答" |

## 验收

```bash
TOKEN=$(curl -s -X POST localhost:3000/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"123456"}' | jq -r .accessToken)

# 只检索：看两路是否都有贡献
curl -s -X POST localhost:3000/rag/search -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"query":"差旅报销标准","topK":5}' | jq '.[] | {score, bm25Score, vectorScore, documentTitle}'

# 带引用的问答
curl -s -X POST localhost:3000/ai/chat -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"content":"P0 故障谁指挥？","topK":5}' | jq '{answer, sources}'
```

样例语料：`test-files/rag-canary.json`、`rag-incident.json`、`rag-onboarding.json`、`rag-visibility.json`；脚本 `curl-rag.md`。

| 检查点 | 期望 |
|---|---|
| 启动日志 | 无 `Mapped {/ai/rag/search}`（说明前缀写错） |
| `/rag/search` | 返回数组，每项有 `score`；两路都命中时 `bm25Score` 与 `vectorScore` 都存在 |
| 关闭 `RAG_RERANK_ENABLED` | 日志「跳过重排」，仍返回结果 |
| 不配 `RERANK_API_KEY` | 同上，不报错 |
| `/ai/chat` | `answer` 句末带 `[1]` 等编号 |
| `sources` | 只含被引用的，`index` 与答案编号一致 |
| 问库外问题 | 「知识库里没有相关内容」或明确说不知道 |
| 空 query | `/rag/search` 返回 `[]`，不报错 |

## 主动回忆

1. **为什么 RRF 用名次而不是分数？**
   BM25 分无上界、余弦分 0~1，量纲不可比；归一化又对分布敏感（长文档/短文档打分范围不同）。名次是天然可比的序数，融合只需 `1/(k+rank)` 累加。

2. **reranker 为什么不能省？**
   RRF 只看「两路各自排第几」，不看 query 与文档的交互；cross-encoder 会把 query 和候选一起编码，能区分「表面相似」和「真正相关」。RRF 丢掉了分差信息，精排补回来。

3. **精排服务挂了，用户会看到什么？**
   不会报错。`rerank` 返回 `null`，`retrieve` 回退 `fused.slice(0, topK)`——用户仍拿到答案，只是排序退化为 RRF 顺序，可能相关性略差。

4. **引用是怎么保证不"假溯源"的？**
   两头夹：生成前用 prompt 强制「依据某条资料必须标 [n] 且编号必须与列表一致」；生成后用正则解析答案里**实际出现**的编号，只回填这些。没标注时回退全部召回（保证前端不为空，但这时 sources 是"可能相关"而非"确实引用"）。

5. **`/rag/search` 和 `/ai/chat` 为什么要分开？**
   前者不调 LLM，零 token 成本、毫秒级返回，适合调召回/融合/精排；后者含生成，慢且花钱。混在一起会让「调检索」变成「每次都在烧 token」。

## 关联

- [[59-RAG混合检索与引用溯源]] —— 课程精读
- [[58-关键词高亮与图谱检索]] —— 上一讲
- 前一篇：`docs/关键词高亮与图谱检索v10总结.md`
