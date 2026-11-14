---
type: course-summary
status: done
course: 64
module: Mem0 + Redis 长短期双层记忆
code_base: ai-agent-code/knowledge/knowledge-hub-backend
tags:
  - 课程总结
  - 记忆
  - Mem0
  - Redis
  - 检索改写
related:
  - "[[63-文档检索可见性控制]]"
  - "[[64-Mem0与Redis双层记忆]]"
---

# Mem0 + Redis 长短期双层记忆 v16 总结

> 课程 64 · 后端 `knowledge-hub-backend`（v16）· 本讲**纯后端**（前端无 v16 分支）
> 整理时间：2026-11-14

## 一句话

**让问答"记得住"**：Redis 存最近几轮原文（热窗口）、Mem0 存抽取后的事实（跨会话画像 + 本会话任务）、再在检索前加一次**问题改写**——三层合起来解决"指代、寒暄、自我介绍、上下文超限"。

## 三层记忆

| 层 | 存储 | 存什么 | 生命周期 |
|---|---|---|---|
| 会话原文 | PG `kh_ai_message` | 全部问答（**事实源**） | 永久（删会话才删） |
| 短期记忆 | Redis `kh:chat:{userId}:{sessionId}:messages` | 最近 20 条 human/ai 原文 | TTL 24h，miss 从 PG 回填 |
| 长期记忆 | Mem0（外部） | 抽取后的事实 | user 层长期 / session 层随会话 |

> **Redis 只是加速层**：TTL 到期不丢历史，只是下次从 PG 加载。这是本讲最重要的设计前提。

## 检索改写（容易被忽略，但决定成败）

`ChatQueryRewriteService.rewrite(question, history)`

```
输入：当前问题 + 压缩历史（最近 4 条；user 200 字 / assistant 120 字）
输出：{ standalone_query, need_retrieve }
```

| 输出 | 用途 |
|---|---|
| `standalone_query` | 拿它去检索，而不是原问题 |
| `need_retrieve` | false 时不检索，当闲聊回复 |

三个工程细节：

1. **助手回答只留 120 字**：否则上一轮的制度细节（金额/审批人）会被当上下文塞进 query，污染检索；
2. `temperature: 0` + 结构化输出：改写要稳定，不要创作；
3. **失败/超时/无历史 → 回退原问题 + `needRetrieve=true`**（宁多检，不漏检）。

例：

```
"那这个找谁？"  →  "出差费用超过五千的加签审批人是谁"
"好的谢谢"       →  need_retrieve=false，不检索
```

## 短期记忆

```ts
key = `${CHAT_SHORT_MEMORY_KEY_PREFIX}:${userId}:${sessionId}:messages`   // 默认 kh:chat
TTL = 86400s
最多 20 条
```

| 方法 | 行为 |
|---|---|
| `tryLoad` | 命中返回消息；**Redis 故障/无 key 返回 `null`**（不是空数组） |
| `save` | 过滤 human/ai，截最后 N 条写入 |
| `appendTurn` | `history + Human(q) + AI(a)` 覆盖写 |
| `clear` | 删 key（删会话时调） |

**只存 `HumanMessage` / `AIMessage`**（`isWorkingMessage` 过滤 system/tool），否则回放会污染下一轮 prompt。

回填在调用方：

```
history = tryLoad(...)
if (!history) {
  rows = listRecentMessages(userId, sessionId, maxMessages)   // PG，DESC 取再 reverse
  history = dbRowsToMessages(rows)
  save(...)                                                    // 顺手回填 Redis
}
```

## 长期记忆（Mem0）

### 两层 scope

| 层 | 写入 | 检索 filter | 内容 |
|---|---|---|---|
| user | `{ userId }` | `{ user_id }` | 身份、岗位、偏好、长期约束 |
| session | `{ userId, runId }` | `AND: [user_id, run_id]` | 本次任务、进度、待办 |

### 写入：先分类，再决定写哪层

分类器（zod 结构化输出）：

```ts
{ write_user: boolean, write_session: boolean, reason: string }
```

Prompt 三条硬边界：

1. **知识库内容永远不写 user 记忆**（制度条文/负责人/系统名是文档事实，不是用户画像）；
2. "这次先看差旅第三节" → 只写 session；
3. 寒暄/致谢/无信息增量 → 都不写。

> 这条最重要：**记忆污染比没有记忆更糟**。一旦把"李明是审批人"写进画像，之后每个会话都带着错误前提。

### 检索：两层都搜，拼成 SystemMessage

```
【用户长期记忆】- 我是成都研发中心后端，偏好简短回答
【当前会话记忆】- 本轮在看差旅住宿上限
以上仅作背景，制度/流程以本轮检索资料为准，不要用记忆替代文档。
```

最后一句是硬约束：**记忆是背景，文档才是事实源**。

### 清理

删除会话时同时：
- `shortMemory.clear()` → 删 Redis key
- `longMemory.clearSession()` → `deleteAll({ userId, runId })`

**user 层必须保留**，否则换个会话就要重新认识用户。

## 流式侧差异

`ai-stream.service` 多了三样：

1. `data-status` 增加 `rewrite` 阶段：「正在理解问题…」→「正在检索知识库…」；
2. `needRetrieve=false` 时不发检索事件、不检索；
3. `summarizationMiddleware`（LangChain）：

```ts
summarizationMiddleware({
  model: compactLlm,          // temperature 0、不带 thinking
  trigger: { messages: 12 },
  keep: { messages: 6 },
  summaryPrompt: '用中文简洁总结：话题、已确认结论、待办。不要写入知识库条文。',
})
```

> 摘要/分类单独用一个 `compactLlm`：开 `enable_thinking` 会让结构化输出不稳。

## 一次问答的完整链路

```
1. loadWorkingHistory（Redis → miss 回 PG → 回填）
2. queryRewrite.rewrite(question, history)
3. Promise.all([
     needRetrieve ? retrieval.retrieve(standalone_query, topK, user) : [],
     longMemory.search(userId, sessionId, standalone_query),
   ])
4. 空召回 → 直接返回"没有相关内容"（也落库 + 记忆）
5. prompt = [system, memoryMsg?, ...history, userTurn]
6. LLM
7. shortMemory.appendTurn(...) + void longMemory.rememberTurn(...)
```

## 改动清单

| 文件 | 行数 | 作用 |
|---|---|---|
| `src/ai/chat-short-memory.service.ts` | +101（新） | Redis 热窗口 |
| `src/ai/chat-long-memory.service.ts` | +219（新） | Mem0 两层 + 分类器 |
| `src/ai/chat-query-rewrite.service.ts` | +101（新） | 检索改写 |
| `src/ai/chat-memory.util.ts` | +53（新） | messageText / isWorkingMessage / dbRowsToMessages / compactRewriteContext |
| `src/ai/ai-chat.service.ts` | +91 | 串起三层记忆 |
| `src/ai/ai-stream.service.ts` | +116 | 流式侧 + summarization |
| `src/ai/chat-session.service.ts` | +17 | `listRecentMessages`、删除时清理 |
| `src/ai/ai.module.ts` | +6 | 注册三个 service |
| `.env.example` / `package.json` | — | 新变量 / `mem0ai@^3.1.8` |

## 配置

```bash
CHAT_SHORT_MEMORY_TTL_SECONDS=86400
CHAT_SHORT_MEMORY_MAX_MESSAGES=20
# CHAT_SHORT_MEMORY_KEY_PREFIX=kh:chat
# AI_QUERY_REWRITE_TIMEOUT_MS=15000
MEM0_API_KEY=              # 不配则整块跳过，不影响问答
MEM0_HOST=https://api.mem0.ai
MEM0_TOP_K=5
MEM0_TELEMETRY=false       # 建议加：否则每次调用都会尝试上报，境外网络超时刷屏
```

## 实战踩的两个坑

### 坑 1：`needRetrieve` 误判（真问题）

```
检索改写：needRetrieve=false query=报销进度要问张敏还是周宁
```

这句**应该检索**（答案在差旅制度里），却被判成"不需要"→ 不检索 → 只能靠历史/常识答 → 答错或说不知道。

修法（二选一）：
- prompt 加硬规则：出现具体人名/部门/制度名，或问"谁负责/找谁/多少"时，一律 `true`；只有纯寒暄才允许 `false`；
- 或改保守默认：不确定就检索（多查一次几百毫秒，漏查代价更大）。

### 坑 2：`MEM0_TELEMETRY` 噪音

```
Telemetry event capture failed: ConnectTimeoutError: 3.41.202.148:443
```

mem0ai SDK 向 PostHog 上报统计，境外网络超时（10s）。**不影响业务**，加 `MEM0_TELEMETRY=false` 关掉。

> 判断依据：如果 Mem0 主接口真的不通，会看到 `Mem0 检索失败` / `Mem0 写入失败`，而不是 telemetry 报错。

### 坑 3：Redis 端口被本地服务抢占

本机 Windows 服务 `rediszt3` 占着 `127.0.0.1:6379`（带密码），Docker 的 Redis 绑 `0.0.0.0:6379` → 连 127.0.0.1 命中前者 → `NOAUTH`。

表现为：短期记忆静默降级（每次查 PG）、密码重置验证码写不进去。停掉本地服务后 `PING → PONG` 恢复正常。

## 易错点

| 坑 | 说明 |
|---|---|
| 知识库内容写进用户画像 | 污染会被后续会话无限放大 |
| 寒暄写记忆 | 无信息增量，只是噪音 |
| 异步写入有延迟 | 刚写完立刻 search 可能搜不到（等 30s 再测） |
| 删会话清了 user 层 | 换会话就要重新认识用户 |
| 记忆替代文档 | 记忆是压缩短句，会丢条件与时效 |
| TTL 太短/太长 | 短→频繁回库；长→内存占用 |
| Redis key 不含 userId | 多用户同 session 会串号 |
| 改写失败没兜底 | 必须回退原问题 + needRetrieve=true |
| 只存 system/tool 消息 | 回放污染 prompt |
| 摘要 keep/trigger 配反 | 触发过早频繁摘要、过晚超上下文 |
| 未配 Mem0 就报错 | 必须 `enabled=false` 优雅跳过 |

## 验收（照作者的四组题）

先上传并发布 `test-files/` 里 6 篇 PDF。

| # | 场景 | 期望 |
|---|---|---|
| 1 | 同会话：问加签 → "那这个找谁？" | 仍钉在差旅/总监加签；日志 query 是短句 |
| 2 | 同会话：问灰度 → "那这个谁负责？" | 钉在发布 SOP（李明/王芳），不漂回差旅 |
| 3 | 新会话："我刚才说要写什么？" | 能复述（短期记忆，不依赖 Mem0） |
| 4 | A 会话声明偏好 → 等 30s → B 会话提问 | 按偏好作答（user 层生效） |
| 5 | C 会话"只看住宿上限" → D 会话提问 | D 不应默认还在查住宿（session 层不跨会话） |
| 6 | "好的谢谢" | 正常寒暄，不回"没有相关内容" |

## 主动回忆

1. **三层记忆各存什么？为什么 Redis 不能当唯一来源？**
   原文在 PG（事实源）、热窗口在 Redis（加速）、事实在 Mem0（跨会话）。Redis 会过期/故障，必须能从 PG 重建。

2. **为什么改写要限制助手回答的长度？**
   助手回答含制度细节（金额、审批人），全文进改写上下文会把 query 带偏；120 字只保留"话题"。

3. **Mem0 分类器为什么必要？**
   直接写会把制度条文、负责人写进用户画像 → 污染后续所有会话。分类器把"文档事实"和"用户事实"分开。

4. **`needRetrieve=false` 的代价为什么更大？**
   false negative（该查没查）会答错或答不出；false positive（不该查却查了）只多花几百毫秒。

5. **删会话为什么只清 session 层？**
   user 层是"你是谁"，跨会话复用；清掉等于每次都要重新自我介绍。

## 关联

- [[64-Mem0与Redis双层记忆]] —— 课程精读
- [[63-文档检索可见性控制]] —— 上一讲
- 前一篇：`docs/文档检索可见性控制v15总结.md`
