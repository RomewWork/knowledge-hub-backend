---
type: course-summary
status: done
course: 51
module: 异步RAG流水线
code_base: ai-agent-code/knowledge/knowledge-hub-backend
tags:
  - 课程总结
  - 异步索引
  - RabbitMQ
  - Embedding
  - Elasticsearch
  - Agent全栈
related:
  - "[[51-异步RAG流水线]]"
  - "[[52-全文检索链路]]"
  - "[[53-知识图谱索引链路]]"
  - "[[54-文档审核与状态机]]"
---

# 异步 RAG 流水线 v3 总结（发布 → MQ → 分块 → Embedding → kh_chunk）

> 对应课程：51 企业级知识库项目 · 基于消息队列的异步 RAG 流水线（RabbitMQ 基础见 40）
> 代码基线：`ai-agent-code/knowledge/knowledge-hub-backend`（学习项目，v3 在工作区，尚未提交）
> 技术栈：Nest 12 + amqp-connection-manager/amqplib + @langchain/textsplitters + @langchain/openai + @elastic/elasticsearch 8.17 + RabbitMQ 3.13 + ES 8.17（IK）+ PG16/MongoDB 7
> 整理时间：2026-10-26

---

## 0. 一页速览

v3 只做一件事：**把「发布」从「同步建索引」里拆出来**。发布接口只改 Postgres 状态并投一条消息；RAG 消费者异步完成 `分块 → Embedding → 写 ES kh_chunk`。

| 维度 | 结论 |
| --- | --- |
| 入口 | `PUT /documents/:id/publish`，无鉴权、无审核（审核在课程 54） |
| 触发条件 | 状态只能是 `Draft(0)` 或 `Published(1)`；已发布再发布会重建索引 |
| 发布动作 | 写 PG：`status=1`、`publish_time=now()`；**再**读 Mongo 正文并投 MQ |
| 交换机 | `rag.reindex.exchange`，`topic`，durable |
| 队列 / 路由键 | `kh.rag.reindex.queue` / `rag.reindex.by_ids`，均 durable |
| 消息体 | `{ taskId: uuid, type: 'BY_DOC_IDS', documentIds: [id] }`，JSON、`persistent: true` |
| 消费入口 | `DocumentPipelineConsumer`（构造器里注册 handler）→ `PipelineOrchestrator` |
| 编排 | 删旧块 → 分块 → 批量 Embedding → bulk 写 `kh_chunk` |
| 分块 | LangChain `RecursiveCharacterTextSplitter`（markdown 分隔符），512 token ≈ 1024 字符 / overlap 64 token ≈ 128 字符 |
| 向量 | DashScope `text-embedding-v3`，1024 维，单批 ≤ 10 条 |
| 索引 | ES `kh_chunk`，单分片 0 副本，`dense_vector(dims=1024, cosine)` |
| 幂等 | 块级 `_id = sha256(documentId:chunkIndex)` 覆盖写 + 写前 `deleteByQuery(document_id)` 全删 |
| 投递失败 | 只记日志，**不回滚**已发布状态（最终一致，但当前无补偿） |
| 未落地 | Search 快照消费者（52）、KG 抽取（53）、审核状态机（54）、RBAC（55）、索引状态表、重试/死信、删除清理 |

```
PUT /documents/:id/publish
  │
  ├─ PG: status=Draft/Published → Published, publish_time=now()   ← 事实源（同步）
  │
  └─ afterPublish(doc) ── publish(exchange, rk, {taskId,type,documentIds})   ← 事件（异步）
        │
        ▼
  rag.reindex.exchange ──topic/rk──► kh.rag.reindex.queue
        │
        ▼
  DocumentPipelineConsumer
        │  handleRagReindex(type, ids)
        ▼
  PipelineOrchestrator
        ├─ 1. PG 取元数据（deleted=false） + Mongo 取正文
        ├─ 2. VectorIndex.deleteByQuery(document_id)     ← 先清旧块
        ├─ 3. ChunkingService.chunk()                     ← Markdown 结构感知
        ├─ 4. EmbeddingService.embedBatch()               ← 10 条/批，1024 维
        └─ 5. VectorIndex.indexChunks()                   ← bulk，_id=chunkId
                │
                ▼
          ES kh_chunk（dense_vector + 过滤字段）
```

### 0.1 与 v2 的差异（增量清单）

| 类别 | v2 | v3 新增 |
| --- | --- | --- |
| 依赖 | v2 的解析/存储依赖 | `amqplib` `amqp-connection-manager` `@langchain/core` `@langchain/openai` `@langchain/textsplitters` `@elastic/elasticsearch` |
| 路由 | 6 个（含 upload/parse） | `+ PUT /documents/:id/publish` |
| 新目录 | `document/` `storage/` | `src/mq/`、`src/pipeline/` |
| 容器 | PG + Mongo + RustFS | `+ rabbitmq` `+ es`（自建 IK 镜像）`+ kibana` |
| 环境变量 | PG/Mongo/RustFS | `+ RABBITMQ_*` `+ RAG_CHUNK_*` `+ EMBEDDING_*` `+ ELASTICSEARCH_*` |
| 数据流 | 上传即解析即入库 | 解析仍同步；**索引**改异步，正文仍是事实源 |
| 一致性 | 双库写，PG 失败回滚 Mongo | 双库写不变 + 索引最终一致（无事务、无补偿） |

### 0.2 与课程主线的关系（重要）

课程 51 讲的是**三条派生索引**的总体设计（Search 存 `kh_document` 快照、RAG 按 ID 重建 `kh_chunk`、KG 抽实体写 Neo4j），但**本节只实现 RAG 一条**，Search 与 KG 分别在课程 52、53。

对应到本项目：

- `DocumentPipelinePublisher.afterPublish()` 目前只投 RAG 一条消息，注释里的 “RAG / KG / ES” 是目标形态，不是现状。
- 消息体已经用 `type: 'BY_DOC_IDS'` 预留了扩展位；Search 的「整篇元数据 + 正文快照」消息要到 52 才加。
- 课程评论区的提问「为什么 Search 传正文，另外两个从库拉正文」正是这个设计的核心取舍（见 §3.3）。

### 0.3 一句话结论

**v3 跑通了「发布 → 投递 → 消费 → 分块 → 向量化 → 写入」的骨架，但只完成了「happy path」。** 幂等的两个关键动作（稳定 `_id`、先删后写）已经做对；可靠性的四个关键动作（ack、重试/死信、失败补偿、删除清理）一个都还没有。

---

## 1. 为什么发布接口只改状态 + 投消息

### 1.1 如果同步建三套索引，时间线会变成这样

```
用户点「发布」
  ├─ 读正文 + 分块                      ~10-100ms
  ├─ Embedding（N 块 / 每批 10 条）      每批 200-800ms × N/10
  ├─ ES bulk 写 kh_chunk                ~50-200ms
  ├─ ES 写 kh_document 快照             ~50-200ms
  ├─ LLM 抽实体 + 写 Neo4j              秒级 ~ 分钟级（重试更久）
  └─ 返回 200
```

一篇 50 页文档轻松 10-60 秒，KG 链路还可能分钟级。网关、浏览器、连接保持都撑不到那时候。

### 1.2 六条硬理由

1. **时间预算不匹配**：发布是用户动作，目标 P99 在几百毫秒；索引是批处理动作，天然是秒级。把两者塞进一个请求，等于用批处理的 SLA 要求交互接口。
2. **故障域不同**：发布只依赖 PG；索引还依赖 embedding API、ES、Neo4j、LLM。任一第三方抖动都会让「发布」失败——但业务上文档明明该发布成功。
3. **没有跨库事务**：PG、Mongo、ES、Neo4j 之间没有分布式事务。同步写三段只能「部分成功」，而且无法回滚已写入的 ES/Neo4j（只能补偿删除）。异步 + 可重建，才是这个约束下的正解。
4. **重试语义不同**：同步失败只能让用户重试整个发布（可能把已成功的索引再写一遍）；异步可以按消费者重试、进死信、按事实源重建，且重试是幂等的。
5. **削峰与背压**：批量导入/迁移时发布会形成洪峰。MQ 缓冲，消费者按自己的速率拉取；同步会把洪峰直接打到 embedding API（DashScope 单批 10 条，超了直接 400）和 ES。
6. **独立演进**：换 embedding 模型、改 chunk 策略、换 ES mapping、加 KG，都不需要动发布接口；重建只需重放消息。

### 1.3 必须承认的代价

| 代价 | 表现 | v3 现状 |
| --- | --- | --- |
| 最终一致 | 发布后一段时间内检索不到 | 窗口 = 队列延迟 + 处理时间，通常 1-10s |
| 需要状态可观测 | 用户/运维不知道索引好没好 | **没有**索引状态字段/表 |
| 需要幂等与重试 | 重复投递、部分失败 | 幂等有（§8.1），重试无 |
| 消息可靠性 | 发布成功但事件丢了 | 投递失败只 log，无 outbox |
| 调试成本 | 跨进程链路 | 靠 `taskId` + 日志，无链路追踪 |

### 1.4 判断标准

什么时候**可以**同步？索引数据量小、只建一套、SLA 允许秒级、第三方稳定、且能接受「发布失败 = 索引失败」时。企业知识库三条链路 + LLM 抽取，显然不满足。

---

## 2. MQ 拓扑与连接生命周期

### 2.1 拓扑（`src/mq/mq.constans.ts`）

| 对象 | 名称 | 参数 | 作用 |
| --- | --- | --- | --- |
| Exchange | `rag.reindex.exchange` | `topic`, durable | 接收重建事件，按 RK 路由 |
| Queue | `kh.rag.reindex.queue` | durable | 本服务消费；`kh.` 前缀避免与本机其他项目撞名 |
| Binding | `rag.reindex.by_ids` | — | 只绑定「按文档 ID 重建」这一种事件 |

命名上留了扩展空间：以后加 `rag.reindex.by_query`、`search.index`、`kg.build` 只需加 RK + 队列，不用改 exchange。

### 2.2 连接 / 通道 / 声明顺序（`rabbitmq.service.ts`）

```
onModuleInit
  ├─ RABBITMQ_ENABLED=false → warn 后直接 return（可选依赖的开关）
  ├─ amqp.connect([url]) → 自动重连的连接管理器
  ├─ createChannel({ json: true, setup })
  │    └─ setup(ch):
  │         assertExchange(topic, durable)
  │         assertQueue(durable) + bindQueue(rk)
  │         bindConsumers(ch)   ← 遍历 handlers，ch.consume(queue, handler)
  └─ waitForConnect() 与 15s 超时 Promise.race
       └─ 超时/失败 → 关闭连接并 throw（应用启动失败）
```

三个细节值得记：

1. **`json: true`**：发布时对象自动序列化、消费时 `msg.content` 仍是 Buffer（本项目手动 `JSON.parse`，因为 `json:true` 只保证发布侧序列化，不会自动反序列化 `ConsumeMessage`）。
2. **`setup` 是幂等的重连钩子**：断线重连后 amqp-connection-manager 会重新执行 `setup`，拓扑和消费者自动恢复——这是选它而不直接用 amqplib 的主要原因。
3. **日志脱敏**：`redactAmqpUrl()` 把 `amqp://user:pass@host` 改成 `user:***@host`，避免密码进日志。

### 2.3 启动期边界（重要）

- **MQ 是启动硬依赖**：15s 内连不上就 `throw`，Nest 起不来。想「先起服务、MQ 后补」只能 `RABBITMQ_ENABLED=false`，没有「连不上先降级、后台重连」的中间态。
- 这与「发布不应被索引阻塞」的初衷有张力：**发布不被阻塞，但服务启动被 MQ 阻塞**。生产更常见的是：启动不阻塞 + 连接恢复后自动补投（outbox/定时扫描）。

### 2.4 发布语义

```ts
await channel.publish(exchange, rk, payload, {
  contentType: 'application/json',
  persistent: true,
});
```

- `persistent: true` + durable queue/exchange，才算「消息落盘」，broker 重启不丢。
- confirm channel 的 `publish` 返回 Promise：**只有 broker 确认后才 resolve**，所以 `ok=false` 代表确实没进 broker，而不是「写进 socket 就算成功」。
- 但 `DocumentPipelinePublisher` 拿到 `false` 只 `logger.log`，没有重试、没有落库补偿——这是 v3 最大的可靠性缺口之一（§8.3 P0-3）。

---

## 3. 生产端

### 3.1 `publish()` 的职责边界（`document.service.ts`）

```ts
// 1. 校验存在 + 状态（仅 Draft / Published）
// 2. PG 写：status=Published, publishTime=now()
// 3. 读 Mongo 正文（只用于返回给前端）
// 4. try { await pipelinePublisher.afterPublish(saved) } catch { warn }  ← 不回滚
// 5. return { ...saved, content }
```

设计上做对了两件事：

- **先落库、再发消息**：消息消费者按 ID 回查，读到的一定是已发布状态和最新正文。
- **投递失败不回滚**：发布是事实源变更，不该被派生数据的失败否定。

设计上缺了两件事：

- **没有 outbox**：若消息真的没发出去，没有任何机制能发现「这篇文档发布了但没索引」。
- **没有返回索引状态**：响应里只有 `status=1`，前端无法区分「已发布」和「可检索」（§10 Q3）。

### 3.2 Publisher 与消息体（`document-pipeline.publisher.ts`）

```ts
const message: ReindexMessage = {
  taskId: randomUUID(),        // 只用于日志关联，不做消费去重
  type: 'BY_DOC_IDS',          // 语义：按 ID 回查事实源重建
  documentIds: [document.id],  // 单篇发布只放一个；批量迁移可放多个
};
```

`taskId` 的定位要清楚：它是**可观测性字段**，不是幂等键。重复投递两条不同 `taskId` 的消息，消费结果必须一样——这靠的是 §8 的块级幂等，而不是 `taskId` 去重。

### 3.3 为什么 RAG/KG 只传 ID，Search 却传正文快照

这是课程 51 评论区的高频问题，答案在「消费者需要什么」：

| 链路 | 消息内容 | 理由 |
| --- | --- | --- |
| RAG | 只传 `document_id` | 正文大（几十 KB~MB），塞进消息会撑爆 broker；消费时回查能拿到**最新**正文；分块/向量化本来就要读全文 |
| KG | 只传 `document_id` | 同上，且抽实体可能耗时很长，消息应尽量小 |
| Search | 传「元数据 + 正文」快照 | 全文索引要的是**发布那一刻**的文档快照；直接给快照可以少一次跨库读，且语义明确「索引的是这一版」 |

代价是 Search 消息大，需要控制大小（超长正文截断/分片）；RAG/KG 则要接受「消费时正文可能已被更新」——这正是需要版本号的原因（v3 没有）。

---

## 4. 消费端

### 4.1 注册时机（`document-pipeline.consumer.ts`）

```ts
constructor(rabbit: RabbitMqService, orchestrator: PipelineOrchestrator) {
  rabbit.registerHandler(RAG_REINDEX_QUEUE, (msg) => this.handleRag(msg));
}
```

`registerHandler` 只往 `Map` 里塞，真正 `ch.consume` 发生在 `RabbitMqService.onModuleInit` 的 `setup` 里。Nest 的生命周期保证所有 provider 先实例化、再调 `onModuleInit`，所以「构造器注册 → init 时绑定」的顺序成立。**如果反过来在 `onModuleInit` 里注册，就会漏绑**。

### 4.2 编排：删 → 切 → 嵌 → 写（`pipeline.orchestrator.ts`）

```ts
async reindexOne(doc) {
  if (!doc.content?.trim()) return;              // 空正文跳过（不写空索引）
  await vectorIndex.deleteByDocId(doc.id);       // ① 先清旧块
  const chunks = await chunking.chunk({...});    // ② Markdown 结构感知切块
  const embeddings = await embedding.embedBatch(chunks.map(c => c.content)); // ③ 批量向量化
  chunks.forEach((c, i) => c.embedding = embeddings[i]);                     // ④ 回填
  await vectorIndex.indexChunks(chunks);         // ⑤ bulk 写入
}
```

顺序不能反：

- **先删后写**：内容变短时，只覆盖不删除会留下「尾部旧块」（第 16-20 块），检索时把已删除的段落召回。
- **先嵌后写**：`dense_vector` 字段虽然可空，但缺 embedding 的块写进去也永远检索不到；先把向量补齐再写。
- **空正文直接 return**：解析失败/空文档不应该在索引里留一条空记录。

### 4.3 异常与失败口径

| 层 | 异常处理 | 结果 |
| --- | --- | --- |
| `reindexOne` 内任意失败（分块/嵌入/bulk） | 被 `handleRagReindex` 的 `try/catch` 吞掉 + `logger.error` | 继续下一篇；**不 nack、不重试**，消息最终仍未 ack |
| `reindexOne` 空正文 | `logger.warn` + return | 无索引，无告警 |
| `deleteByDocId` | `try/catch`，只 log（`index_not_found` 除外） | **删除失败也继续写**，可能残留旧块 |
| `loadDocumentsByIds` 读库失败 | 异常冒泡到 consumer | `nack(requeue=false)` 丢弃 |
| 消息 JSON 解析失败 | `JSON.parse` 抛错 | 同上，丢弃 |

这里有两个反直觉的点：

1. **单篇失败被吞掉**：`handleRagReindex` 把每篇的异常 catch 住了，所以「嵌入 429」「bulk 部分失败」都不会传到消费者，只在日志里留一行 error。
2. **只有「循环外」的异常才会 nack**：真正会触发 `nack(msg, false, false)` 的，只有读库失败、坏消息这类错误；而它又是 `requeue=false` + 无 DLX，消息同样直接消失。也就是说：**业务失败不重试，基础设施失败直接丢**。

---

## 5. 分块（`chunking.service.ts`）

### 5.1 参数

| 配置 | 默认 | 换算 | 实际值 |
| --- | --- | --- | --- |
| `RAG_CHUNK_SIZE` | 512 token | `CHARS_PER_TOKEN = 2.0` | 1024 字符 |
| `RAG_CHUNK_OVERLAP` | 64 token | 同上 | 128 字符 |
| 分隔符 | `['\n# ', ...markdown 默认分隔符]` | `keepSeparator: true` | 标题/代码块/段落/行 |
| 语言 | `getSeparatorsForLanguage('markdown')` | — | 结构感知 |

为什么 `CHARS_PER_TOKEN = 2.0`：中英文混合场景的保守估算（中文约 1 字 ≈ 1 token，英文约 4 字符 ≈ 1 token）。它只是「把 token 预算换成字符预算」的粗估，真实 token 数由 embedding 模型的 tokenizer 决定；`text-embedding-v3` 上限 8192 token，512 token 的块远低于上限。

### 5.2 为什么用 Markdown 分隔符

- `\n# ` 补在第一位：LangChain 内置的 markdown 分隔符**不含 H1**（`\n## ` 有、`\n# ` 没有），不补的话一级标题不会被当作切分点，整篇会按段落硬切。
- `keepSeparator: true`：保留 `#` 前缀，块内容自带标题，检索命中时能看出属于哪一节。
- 递归顺序：先按标题，再按代码块/段落/行，最后才按字符——尽量不在语义边界上切。

### 5.3 heading 继承与前缀补全

```ts
if (headingInChunk) currentHeading = headingInChunk;
let chunkContent = trimmed;
if (currentHeading && !HEADING_LINE.test(trimmed)) {
  chunkContent = `${currentHeading}\n\n${trimmed}`;   // 同章节后续块补标题
}
```

原因：切分后通常只有每一节的第一块自带标题，后续块是「裸段落」。补上所属标题有两个收益：

1. **Embedding 语义更完整**：`## 年假规则\n\n入职满一年可享 5 天` 比 `入职满一年可享 5 天` 更容易被「年假怎么算」召回。
2. **检索结果可直接展示上下文**：命中块自带章节名，前端不用回表。

代价：同一标题会在多个块里重复，`content` 变长、token 略增；跨章节的块不会自动带父级标题（只有最近的 H1-H6）。

### 5.4 chunkId 设计（幂等的基石）

```ts
chunkId: createHash('sha256')
  .update(`${documentId}:${chunks.length}`)   // 注意：用的是当前块序号
  .digest('hex')
  .slice(0, 64)
```

- **稳定**：同一文档、同一序号 → 永远同一 ID。重试时 `_id` 不变，ES `index` 操作是覆盖，不会产生第 21 块。
- **不随机**：如果用 `randomUUID()`，每次重试都会新增一批块，这是 RAG 索引重复数据最常见的原因。
- **碰撞可忽略**：sha256 前 64 hex（256 bit），单文档块数 < 1000，实践无碰撞。
- **不含内容 hash**：内容变了但序号没变时，`_id` 相同 → 覆盖；这正是我们想要的（重建 = 全量替换）。

### 5.5 已知取舍

| 取舍 | 现状 | 影响 |
| --- | --- | --- |
| 按字符估 token | 2 字符/token | 中文块可能偏大，英文块可能偏小 |
| 不做语义分块 | 纯结构切分 | 长段落内语义跨度大时，召回粒度不够 |
| 表格不单独成块 | 跟随段落 | 表格被切开后表头丢失（52/53 再做） |
| 无父子块 | 单层 | 命中块缺少更完整的父级上下文（可用 small-to-big 补） |
| `totalChunks` 切完才回填 | 先 0 后补 | 单块文档写入前 `totalChunks` 为 0，靠最后统一赋值 |

---

## 6. 向量化（`embedding.service.ts`）

| 配置 | 默认 / 取值 | 说明 |
| --- | --- | --- |
| `EMBEDDING_BASE_URL` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | OpenAI 兼容模式 |
| `EMBEDDING_MODEL` | `text-embedding-v3` | DashScope |
| `EMBEDDING_DIMENSION` | 1024 | **必须**与 ES mapping 的 `dims` 一致 |
| `EMBEDDING_BATCH_SIZE` | 10 | 代码里 `Math.min(config, 10)` 硬钳制 |
| API Key | `EMBEDDING_API_KEY` → `DASHSCOPE_API_KEY` → `OPENAI_API_KEY` | 三者取第一个非空 |
| `stripNewLines` | `false` | 保留 Markdown 换行，避免语义被压扁 |

两个关键点：

1. **批次上限是硬约束**：DashScope `text-embedding-v3` 单次最多 10 条，代码把配置钳到 10 并 warn，避免线上配 100 直接 400。代价是 200 块的文档要串行 20 次 API 调用，耗时线性增长——后续应改「并发 + 限流 + 分批」。
2. **维度是索引契约**：`dims: 1024` 写进 mapping 后，换模型（如 1536 维）必须重建索引，不能原地改。`VectorIndexService` 和 `EmbeddingService` 读同一个 `EMBEDDING_DIMENSION`，保证两边一致。

**启动耦合**：`EmbeddingService` 构造器里拿不到 Key 会直接 `throw`，导致整个应用启动失败。也就是说「只想跑 CRUD」也必须配好 embedding key——这在本地开发/CI 里很容易卡住。合理做法是懒加载 + 调用时校验。

---

## 7. 向量索引（`vector-index.service.ts`）

### 7.1 `kh_chunk` mapping

| 字段 | 类型 | 用途 |
| --- | --- | --- |
| `chunk_id` | keyword | 与 `_id` 冗余，便于聚合/回查 |
| `document_id` | keyword | **按文档删除/过滤的主键**（雪花 ID 用字符串，避免 JS long 精度） |
| `document_title` | text + keyword | 全文匹配 + 精确聚合/排序 |
| `content` | text | 正文（当前默认分词器；要中文 BM25 需 `ik_max_word`，52 再处理） |
| `heading` | keyword | 章节过滤/展示 |
| `chunk_index` / `total_chunks` | integer | 顺序、覆盖率、断言 |
| `category_id` / `author_id` / `team_id` | keyword | 权限/分类过滤（55 用） |
| `doc_status` | integer | 发布状态过滤（**当前写入的是发布时的值，归档不会更新**） |
| `publish_time` / `indexed_at` | date | 时间过滤、判断索引新鲜度 |
| `embedding` | dense_vector | `dims=1024, index=true, similarity=cosine` |

索引级参数：`number_of_shards: 1`、`number_of_replicas: 0`、`refresh_interval: 5s`——单机开发配置，生产要按数据量调副本与刷新间隔。

### 7.2 写路径

```ts
// ① 删除
await es.deleteByQuery({
  index: 'kh_chunk',
  query: { term: { document_id: documentId } },
  refresh: true,          // 立刻对搜索可见
});

// ② 批量写
const operations = chunks.flatMap(chunk => [
  { index: { _index: 'kh_chunk', _id: chunk.chunkId } },   // 固定 _id → 覆盖
  buildDocMap(chunk),
]);
const response = await es.bulk({ refresh: true, operations });
if (response.errors) throw new Error(`ES 批量索引部分失败：${failed.length} 条`);
```

- **`refresh: true`**：测试时能立刻 `_search` 到；生产应关掉（或依赖 5s 定时刷新），否则每次写都触发 refresh，吞吐会掉。
- **bulk 部分失败会抛错**：`response.errors` 为 true 时抛异常；但异常会被 `handleRagReindex` 的单篇 `try/catch` 吞掉，只留日志，消息不会重投（§4.3）。
- **索引不存在时自动创建**：`onModuleInit` 里 `indices.exists` → `create`，`resource_already_exists` 视为成功（多实例并发启动的竞态兜底）。

### 7.3 读路径（后续课程）

v3 只写不读。课程 52 把文档快照写入 `kh_document`，提供文档级 BM25 检索；`kh_chunk` 的 kNN 检索与混合融合在检索侧接入（RRF/Rerank 见课程 29）。两者同库，才有「向量 + 关键词」一次查询的可能。

---

## 8. 幂等与一致性（核心）

### 8.1 幂等矩阵（当前代码的真实行为）

| 场景 | 动作 | 当前结果 | 幂等 | 备注 |
| --- | --- | --- | --- | --- |
| 同一消息重复投递 | 重建 | 删旧 + 覆盖同 `_id` | ✅ | 块级幂等 |
| 已发布再点发布 | 重建 | 同上 | ✅ | `publish` 允许 `Published` |
| 内容变短（20→15 块） | 重建 | 先删 20 块，再写 15 块 | ✅ | 依赖删除成功 |
| 删除失败被吞 | 重建 | 第 16-20 块残留 | ❌ | `deleteByDocId` 只 log |
| 内容变长 | 重建 | 覆盖 20 + 新增 5 | ✅ | — |
| 两个消费者并发（旧内容后写） | 并发重建 | 旧内容可能覆盖新内容 | ❌ | 无版本号/无锁 |
| 更新正文（不重新发布） | `PATCH` | ES 不更新 | ❌ | 只有 publish 触发 |
| 删除文档 | `DELETE` | PG/Mongo 软删，ES 不动 | ❌ | 检索仍可召回 |
| 归档文档 | `PATCH status=2` | ES 里 `doc_status` 仍是 1 | ❌ | 需查询侧过滤 + 清理 |
| 发布时 MQ 不可用 | 投递 | log warn，索引缺失 | ❌ | 无 outbox/补偿 |
| 单篇处理失败（分块/嵌入/写入） | 失败 | 被吞，继续下一篇 | ❌ | 消息未 ack，重启才重投 |
| 读库失败 / 坏消息 | 失败 | `nack(requeue=false)` 丢弃 | ❌ | 无 DLQ/重试 |
| 消费成功 | 正常 | **没有 `ack`** | ⚠️ | 消息悬挂为 unacked，重启后重投 |

最后一行需要展开：`amqplib` 的 `channel.consume(queue, cb)` 默认 `noAck: false`（手动确认）。本项目在 `bindConsumers` 里只处理了 `nack`，**成功路径没有 `ch.ack(msg)`**。结果是消息一直处于 unacked，队列的 `messages_unacknowledged` 持续增长；channel 关闭（重启/断线）后 broker 会重新投递，于是「重启一次，全量重建一次」。因为块级幂等，数据不会重复，但会白白消耗 embedding 调用。

### 8.2 失败路径逐个走

```
发布成功 → 投递失败        → 索引永久缺失（只能人工重放）
发布成功 → 投递成功 → 消息丢失（broker 异常） → 同上
消费 → 读库失败 / 坏消息    → 异常冒泡 → nack 丢弃 → 索引缺失
消费 → 分块为空            → warn + return → 无索引，无告警
消费 → Embedding 429/超时  → 被单篇 try/catch 吞 → 该文档 0 块（旧块已删！）
消费 → 删除成功、写入失败   → 被吞 → 该文档 0 块，检索直接漏召回
消费 → 写入部分失败        → 抛错被吞 → 部分块缺失
消费成功但未 ack           → 重启后重投 → 重复重建（幂等，浪费成本）
```

最危险的是 **「先删后写」+「失败不重试」** 的组合：删除成功、写入失败时，文档在 ES 里变成 0 块，检索彻底漏掉它，而且没有任何重试。生产必须补「写成功后再删旧版本」或用别名切换，或者至少保证失败可重试。

### 8.3 缺口清单

**P0（会导致数据错误或丢失）**

1. 成功消费不 `ack` → unacked 堆积 + 重启重投。
2. 读库失败/坏消息 `nack(requeue=false)` + 无 DLX → 消息直接消失；业务失败则被单篇 catch 吞掉（P1-11）。
3. 投递失败无 outbox/重试 → 发布成功但索引缺失。
4. 删除/归档不清理 ES → 已下线内容仍可被召回。
5. 更新正文不触发重建 → 检索到旧内容。

**P1（一致性/可运维性）**

6. 无版本号/幂等表 → 并发重建可能旧覆盖新，无法判断索引是否对应当前版本。
7. 无索引状态表 → 前端/运维无法知道「构建中/成功/失败」。
8. `deleteByDocId` 吞异常 → 残留旧块。
9. ES 启动时不可用 → `es=null` 永久降级（进程内不再重试）。
10. 无 prefetch → broker 把队列消息全部推给消费者，无法控制并发与积压（消息小，主要是 unacked 堆积）。
11. `handleRagReindex` 吞单篇异常 → 失败只留日志，无告警。

**P2（配置/体验）**

12. `EMBEDDING_*` 缺失导致启动失败（应懒加载）。
13. `MQ` 连不上导致启动失败（应允许降级 + 后台重连）。
14. ES `content` 用默认分词器，中文 BM25 效果差（52 处理）。
15. 雪花 ID 环境变量名不一致：代码读 `SNOWFLAKE_MACHINE_ID`，`.env` 写 `SNOWFLAKE_WORKER_ID`（默认都是 1，暂无影响）。
16. 文件名笔误：`mq.constans.ts`、`pipeline.messagets.ts`（不影响运行，建议改）。

### 8.4 生产补法（目标架构）

```
发布事务（PG）
  ├─ update kh_document set status=1, version=version+1
  └─ insert outbox(document_id, version, pipeline='rag', status='pending')
        │  （同一事务，原子）
        ▼
  Outbox Relay（定时/CDC）──► MQ（消息体带 document_id + version）
        ▼
  Consumer
  ├─ 幂等表：insert (doc_id, version, pipeline) on conflict do nothing
  │    └─ 已成功 → 直接 ack 短路
  ├─ 版本比较：version <= indexed_version → ack 跳过
  ├─ 处理：分块 → 嵌入 → 写新索引（_id 带 version 或双写 + 别名切换）
  ├─ 成功：更新状态表 succeeded + ack
  └─ 失败：状态 failed + nack/requeue（指数退避）→ 超限进 DLQ + 告警
        ▼
  对账 Job（每小时）
  └─ 扫 Published 文档 vs ES 块数/版本，补建或告警
```

关键原则：**ack 只在状态落库之后；重试必须幂等；删除与更新同样走事件；任何「事实源有、索引无」都能被对账发现。**

---

## 9. 手测与验收

### 9.1 命令

```bash
# 1. 起容器（rabbitmq / es / kibana / pg / mongo / rustfs）
docker compose up -d

# 2. 起服务（.env 里 PORT=8080，注意 curl3 里 3000/8080 混用）
pnpm start:dev

# 3. 发布（DOC_ID 用上传接口返回的 documentId）
curl -s -X PUT "http://localhost:8080/documents/${DOC_ID}/publish"

# 4. 看索引
curl -s "http://localhost:9200/_cat/indices?v"
curl -s "http://localhost:9200/kh_chunk/_search" -H 'Content-Type: application/json' -d '{
  "size": 100,
  "query": { "match_all": {} }
}'
```

### 9.2 检查点

| 检查 | 期望 |
| --- | --- |
| `publish` 响应 | `status=1`，`publishTime` 有值 |
| 消费日志 | `[RAG] type=BY_DOC_IDS`、`RAG 索引完成：chunks=N` |
| `kh_chunk` 文档数 | 等于该文档块数，且 `document_id` 全部一致 |
| `embedding` 维度 | 1024，`dims` 与 mapping 一致 |
| 再发布一次 | 文档数不变（覆盖，不翻倍） |
| 改短正文再发布 | 文档数变少，无尾部残留 |
| 停掉 ES 再发布 | 发布仍成功，日志出现「跳过向量索引写入」 |
| 停掉 MQ 再启动服务 | 15s 后启动失败（当前行为） |

### 9.3 可能踩到的坑

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| 消费没触发 | handler 注册晚于 `onModuleInit` | 保持在构造器注册 |
| `dense_vector` 写入 400 | `EMBEDDING_DIMENSION` 与 mapping `dims` 不一致 | 改维度必须删索引重建 |
| `text-embedding-v3` 400 | 单批 > 10 条 | 代码已钳制，别再调大 |
| 索引里块数翻倍 | 用了随机 `_id`，或 `deleteByQuery` 失败被吞 | 查删除日志；手动按 `document_id` 清理 |
| 发布后检索不到 | 最终一致窗口 / 消费失败被吞 | 查日志 + ES 块数 + 队列 unacked |
| 队列 unacked 一直涨 | 没 `ack` | 补 `ch.ack(msg)` |
| 重启后重复调用 embedding | 未 ack 导致重投 | 同上 |

---

## 10. 主动回忆（完整版答案）

### Q1 为什么发布接口不应同步建三套索引？

**因为「发布」是事实源变更，「索引」是可重建的派生数据，两者的 SLA、故障域和重试语义完全不同。**

1. **延迟不可接受**：三套索引里最慢的是 KG（LLM 抽实体，秒级到分钟级）和 RAG（N 批 embedding，每批一次网络 RTT）。同步会让发布 P99 从毫秒级变成十秒级，网关/浏览器先超时。
2. **故障域被强行合并**：发布只依赖 PG；索引还依赖 embedding API、ES、Neo4j、LLM。同步意味着第三方抖动 = 发布失败，但业务上文档该发布成功。
3. **没有跨库事务**：PG/Mongo/ES/Neo4j 无法原子写，同步只能「部分成功」，且已写入的 ES/Neo4j 无法回滚。异步 + 幂等重建才是这个约束下的正解。
4. **重试代价不同**：同步失败只能让用户重试整个发布（可能重复写已成功的索引）；异步可以按消费者重试、进死信、按事实源重建。
5. **削峰与隔离**：批量导入时发布会形成洪峰，MQ 缓冲 + 消费者独立扩缩容；同步会把压力直接打到 embedding 限流和 ES。
6. **演进自由**：换模型、改分块、换 mapping、加 KG，都不用动发布接口；重建只需重放消息。

**代价**：最终一致窗口、需要索引状态与对账、需要幂等/重试/死信。这些复杂度没有消失，只是从「接口」转移到了「消费者 + 运维」。所以同步不是错，错在「用交互接口的 SLA 去承担批处理的成本」。

> 一句话：**发布只对事实源负责，索引对副本负责；副本可以慢、可以失败、可以重建，但不能拖垮发布。**

### Q2 重试如何避免重复数据？

**靠「稳定的块 ID + 全量替换」这两件事，而不是靠「只消费一次」。**

1. **块级稳定 `_id`**：`chunkId = sha256(documentId:chunkIndex)`，同一文档同一序号永远同一 ID。ES 的 `index` 操作对同 `_id` 是覆盖，所以重复消费/重试不会追加第 N+1 块。
2. **写前全删**：`deleteByQuery({ term: { document_id } })` 清掉该文档所有旧块。即使内容变短（20→15 块），也不会留下第 16-20 块的「尾巴」。
3. **全量重建而非增量 diff**：消费者不比较新旧差异，直接重算重写。逻辑简单，天然幂等；代价是每次重跑都要重新 embedding。
4. **消息 `taskId` 不做去重**：它只用于日志关联。两条不同 `taskId` 的消息处理同一文档，结果必须一致——这正是幂等设计要保证的。
5. **删除/归档也要发清理事件**：否则「文档没了、索引还在」，这是另一种重复（幽灵数据）。v3 未做，是缺口。

**当前实现的三个漏洞**：

- `deleteByDocId` 吞异常 → 删除失败仍继续写，旧块残留。
- 无版本号 → 两个消费者并发时，旧内容可能后写覆盖新内容。
- 先删后写 + 失败丢弃 → 删除成功、写入失败时文档变 0 块（不是重复，是丢失）。

**生产补法**：幂等表（`doc_id + version + pipeline` 唯一键）、消息带 `version`、`if_seq_no`/脚本条件更新、成功才 ack、失败退避重试 + DLQ、每小时对账。

### Q3 索引最终一致时前端应展示什么状态？

**要区分三个状态，不能只显示 `status=1`：**

| 状态 | 含义 | 前端展示 |
| --- | --- | --- |
| 业务状态 | Draft / Published / Archived | 「草稿」「已发布」「已归档」 |
| 索引状态 | 每条管线的 pending / processing / succeeded / failed | 「索引构建中」「可检索」「部分失败」 |
| 检索可用性 | 当前版本是否已能被召回 | 搜索框是否包含它 |

具体建议：

1. **发布响应立即返回** `status=Published` + `indexStatus=processing` + `taskId`，前端显示「已发布 · 索引构建中（预计几秒）」，**不要**显示「已上线」。
2. **详情/列表用徽标**：🟡构建中、🟢可检索、🔴失败（附「重试」按钮）；三路索引分别显示，明确哪条失败。
3. **更新场景**：显示「有新版本待索引」，旧版本仍可检索（读旧副本），或标记「更新中」。
4. **删除/归档**：立即从检索结果隐藏（查询侧过滤 `doc_status/deleted`），索引清理异步进行，显示「已下架」。
5. **刷新方式**：发布后轮询 `GET /documents/:id/index-status`（1-2s 起，指数退避），或 SSE 推送；页面离开再回来能查到最终态。
6. **兜底文案**：processing 超过 SLA → 「索引较慢，可重试」；failed → 「索引失败，内容已保存，可重试」。
7. **验收口径**：`chunk_count > 0` 且 `indexed_at >= publish_time` 才算「可检索」，比「接口 200」可靠。

**当前 v3 的差距**：没有索引状态字段/表，`publish` 直接返回 `status=1`，消费者成功后也不回写任何状态。前端只能显示「已发布」，无法区分「已发布但索引失败」。要落地需要：`kh_document_index_status` 表（或 `kh_document` 加字段）+ 消费者回写 + 查询接口，与课程 54 的文档状态机配套。

---

## 11. 面试追问速答

1. **为什么用 MQ 而不是直接 `await`？**
   发布只依赖 PG，索引依赖多个第三方且耗时；异步解耦故障域、支持重试与重建。代价是最终一致，需要状态与对账。
2. **消息里为什么只放 document_id？**
   正文太大；消费时回查能拿最新正文；RAG/KG 本来就要读全文。Search 需要「发布那一刻」的快照，所以单独传正文。
3. **怎么保证不重复？**
   块 `_id = sha256(docId:index)` 覆盖写 + 写前按 `document_id` 全删；全量重建而非增量。
4. **消费失败了怎么办？**
   当前两条路都不合格：单篇失败被 `try/catch` 吞掉（只留日志）；读库/坏消息才 `nack`，且 `requeue=false` 直接丢弃。生产：成功才 ack，失败退避重试，超限进 DLQ + 告警，状态表记 failed，支持人工/对账重建。
5. **为什么先删后写？**
   防止内容变短时残留尾部旧块。代价是「删成功、写失败」会短暂 0 块，生产可用「写新索引 + 别名切换」或版本化索引避免。
6. **ES 能当向量库吗？**
   能，`dense_vector` + kNN；好处是向量和 BM25 同库、过滤字段齐全、运维一套。代价是维度绑定 mapping、大规模向量性能不如专用向量库（Milvus）。
7. **embedding 维度改了怎么办？**
   删索引重建（mapping 的 `dims` 不可改）；消息重放全量重建。不能原地改。
8. **怎么知道索引是否最新？**
   消息带 `version`，ES 文档存 `version`/`indexed_at`；查询或对账时比较 `version` 与 `publish_time`。v3 只有 `indexed_at`，不够。

---

## 12. v4 待办

**本模块（P0，先修正确性）**

1. 消费成功 `ack`；失败 `nack(requeue=true)`（有限次）+ DLX/DLQ。
2. 发布走 outbox（或至少投递失败落库 + 定时补投）。
3. 删除/归档发清理事件，`remove()` 后清 ES；`update()` 正文变更触发重建。
4. `deleteByDocId` 失败必须抛出，不能吞。
5. 加 `version`（PG `kh_document.version` 或 `updated_at` 毫秒）到消息与 ES 文档，写入前比较。
6. 加索引状态表/字段（doc_id, pipeline, version, status, attempts, error, updated_at），消费者回写。

**下一课（52/53/54/55）**

7. 52：Search 消费者写 `kh_document` 快照；`content` 配 IK 分词；BM25 检索（kNN/RRF 在检索侧接入）。
8. 53：KG 消费者分块抽实体写 Neo4j（`Document—Chunk—Entity`）。
9. 54：审核状态机（草稿 → 审核中 → 已发布/已拒绝），发布接口加审核前置。
10. 55：JWT + RBAC + 数据权限（`team_id`/`author_id` 过滤，ES 查询侧也要带）。

**工程化**

11. prefetch + 并发消费；embedding 并发限流（而不是串行批 10）。
12. 对账 Job：Published 文档 vs ES 块数/版本。
13. 链路追踪：`taskId` + OpenTelemetry，串起 publish → consumer → embedding → ES。
14. 测试：单测分块（heading/overlap）、幂等（重复消费块数不变）、失败（nack/DLQ）。

---

## 13. 自测清单

- [ ] 不看代码，画出「发布 → 投递 → 消费 → 分块 → 嵌入 → 写入」六步，并说出每步失败时的现象。
- [ ] 说清 `type: 'BY_DOC_IDS'` 和 Search「快照消息」的差别，以及为什么。
- [ ] 解释为什么 `chunkId` 不能用 `randomUUID()`。
- [ ] 解释「先删后写」解决什么问题、又引入什么问题。
- [ ] 说出 `ack` 缺失会导致的两个现象（unacked 堆积、重启重投）。
- [ ] 说出 ES `deleteByQuery` 吞异常在「内容变短」时会造成什么脏数据。
- [ ] 手测：发布一篇文档 → 查 `kh_chunk` 块数 → 再发布一次 → 块数不变。
- [ ] 手测：把正文改短再发布 → 块数变少、无残留。
- [ ] 手测：`ELASTICSEARCH_ENABLED=false` 启动 → 发布成功但无索引，日志有 warn。
- [ ] 设计一张索引状态表，并写出前端三种徽标的取数逻辑。

---

## 14. 关联笔记

### 本模块（03-课程精读）

- [[51-异步RAG流水线]] —— 本讲精读（主动回忆答案在笔记里）
- [[50-多格式文件转Markdown]] —— v2：解析产物从哪来
- [[52-全文检索链路]] —— 下一讲：Search 快照 + BM25
- [[53-知识图谱索引链路]] —— 下一讲：Neo4j 实体抽取
- [[54-文档审核与状态机]] —— 索引状态与审核状态
- [[55-用户鉴权与RBAC]] —— 查询侧权限过滤

### 项目与教学版

- [[07-异步三路索引流水线]] —— 三路索引的项目视角
- [[11-异步三路索引教学版]] —— 幂等键/失败恢复表
- [[10-RabbitMQ与最终一致性教学版]] —— ack/重试/死信
- [[40-RabbitMQ异步处理]] —— MQ 基础
- [[07-企业知识库实战导学]]

### 落地文件

- 入口：`src/document/document.service.ts`（`publish`）
- MQ：`src/mq/`（`rabbitmq.service.ts`、`document-pipeline.publisher.ts`、`document-pipeline.consumer.ts`、`mq.constans.ts`）
- 管线：`src/pipeline/`（`pipeline.orchestrator.ts`、`chunking.service.ts`、`embedding.service.ts`、`vector-index.service.ts`）
- 手测：`docs/curl/curl3.md`
- 前一篇：[[文档模块v2总结]]
