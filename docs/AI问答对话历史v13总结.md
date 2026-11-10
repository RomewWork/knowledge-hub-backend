---
type: course-summary
status: done
course: 61
module: AI 问答对话历史
code_base:
  - ai-agent-code/knowledge/knowledge-hub-backend
  - ai-agent-code/knowledge-hub-frontend
tags:
  - 课程总结
  - AI会话
  - 数据库设计
  - RAG
related:
  - "[[60-前端界面与前后端联调]]"
  - "[[61-AI问答对话历史]]"
---

# AI 问答对话历史 v13 总结

> 课程 61 · 后端 `knowledge-hub-backend`（v13）· 前端 `knowledge-hub-frontend`（v13）
> 整理时间：2026-11-11

## 一句话

**给单轮问答加上"可回看"**：两张表（会话 + 消息）+ 6 个接口 + 前端 URL 驱动的会话切换。本质是**会话存档**，不是多轮对话——历史消息不参与生成。

## 与 v12 的差异

| 能力 | v12 | v13 |
|---|---|---|
| 会话列表 | ❌ | ✅ 左侧列表，`updatedAt DESC` |
| 历史回看 | ❌ | ✅ 点会话拉消息 |
| 新建 / 删除会话 | ❌ | ✅ |
| 重命名 | ❌ | 后端有 `PATCH`，**前端未做 UI** |
| 多轮上下文 | ❌ | ❌（仍单轮） |

## 数据模型

```sql
kh_ai_session   id, user_id, title(80), created_at, updated_at
                INDEX (user_id, updated_at DESC)     -- 列表查询

kh_ai_message   id, session_id → kh_ai_session(id) ON DELETE CASCADE,
                role('user'|'assistant'), content TEXT, sources JSONB, created_at
                INDEX (session_id, created_at)
```

两个设计点：

1. **`ON DELETE CASCADE`**：删会话自动清消息，不留孤儿；但只给"从属关系明确"的子表加，审计/日志表绝不能加。
2. **`sources` 用 JSONB**：引用是整块快照（含 index/title/excerpt/score），结构会演进，按整体存取更自然；代价是无法按片段反查、不能建普通索引。

## 后端接口（全部 `@RequirePermission('search')`）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/ai/chat` | 多了 `sessionId?`，返回体多了 `sessionId` |
| GET | `/ai/sessions` | 我的会话分页 |
| POST | `/ai/sessions` | 新建空会话（title 可选，默认「新对话」） |
| GET | `/ai/sessions/:id/messages` | 消息列表，`createdAt ASC, id ASC` |
| PATCH | `/ai/sessions/:id` | 重命名（1~80 字） |
| DELETE | `/ai/sessions/:id` | 删除（先删消息再删会话） |

## 核心逻辑：`appendTurn`

```
appendTurn(userId, sessionId?, question, answer, sources)
 ├─ 有 sessionId → getOwned 校验归属
 ├─ 无 sessionId → create（标题取首问前 30 字）
 ├─ title 仍是「新对话」→ 用首问覆盖（用户改过就不动）
 ├─ session.updatedAt = now  → 列表冒泡到顶部
 └─ 一次 save 两条：user + assistant（assistant 带 sources）
```

**为什么 user 和 assistant 一起写**：避免"问句落库、回答丢失"的半截会话。

**为什么空召回也落库**：`ai-chat.service` 里"知识库里没有相关内容"这个分支同样调用 `appendTurn`——用户看到的是"没答上来"，运营需要知道哪些问题没覆盖。

**为什么用 `getOwned`**：所有会话操作都带 `where: { id, userId }`，别人的会话查不到 → 404。**越权防护在后端，不靠前端只显示自己的**。

## 前端机制

**URL 是唯一状态源**：`/chat?session=xxx`

- `sessionId` 从 `useSearchParams` 读；
- 切会话时先 `setMessages([])` 再拉消息，避免旧内容闪一下；
- 首问后后端返回新 `sessionId` → `navigate(..., { replace: true })`（不污染历史栈）；
- 每次发送后 `loadSessions()` 刷新左侧列表（标题可能刚被覆盖）。

## 改动清单

| 端 | 文件 | 改动 |
|---|---|---|
| 后端 | `src/ai/entities/ai-session.entity.ts`、`ai-message.entity.ts` | 新增两实体 |
| 后端 | `src/ai/chat-session.service.ts` | 新增（121 行）：分页/创建/改名/删除/消息/落库 |
| 后端 | `src/ai/dto/session.dto.ts` | 新增 3 个 DTO |
| 后端 | `src/ai/dto/chat.dto.ts` | 加 `sessionId?` |
| 后端 | `src/ai/chat.types.ts` | `ChatSource` 抽出，避免 service 互相 import |
| 后端 | `src/ai/ai-chat.service.ts` | 注入 session service，两处 `appendTurn` |
| 后端 | `src/ai/ai.controller.ts` | 新增 5 个路由 |
| 后端 | `src/ai/ai.module.ts` | 注册 `ChatSessionService` |
| 后端 | `init-scripts/postgresql/init.sql` | 两张表 + 两个索引 |
| 前端 | `src/types.ts` | `ChatSession`、`ChatMessage` |
| 前端 | `src/api/index.ts` | `aiApi` 加 5 个方法，`chat` 加 `sessionId` |
| 前端 | `src/pages/ChatPage.tsx` | 会话列表 / 切换 / 新建 / 删除 |

## 易错点

| 坑 | 说明 |
|---|---|
| **老库不建表** | `init.sql` 只在空库执行，已存在的数据卷必须手动跑增量脚本或 migration |
| **历史不进 prompt** | 追问「那他是谁」时模型看不到上一轮，答案是断片的 |
| 标题覆盖 | 只在 `title === '新对话'` 时用首问覆盖 |
| 同毫秒排序 | `createdAt ASC, id ASC`，只按时间会乱序 |
| 删除顺序 | 先删消息再删会话（CASCADE 是兜底，不是唯一手段） |
| URL 为状态源 | 换会话要清空 messages，否则闪旧数据 |
| `sources` 结构演进 | 旧行可能是旧形状，读取要容错 |
| 重命名接口空转 | 后端有、前端没 UI，别以为坏了 |

## 验收

```bash
# 首问不传 sessionId，返回体带回一个
SID=$(curl -s -X POST localhost:3000/ai/chat -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"content":"P0 故障谁指挥？"}' | jq -r .sessionId)

curl -s localhost:3000/ai/sessions -H "Authorization: Bearer $TOKEN" | jq '.items[] | {id,title}'
curl -s "localhost:3000/ai/sessions/$SID/messages" -H "Authorization: Bearer $TOKEN" | jq 'length'   # 2
```

| 检查点 | 期望 |
|---|---|
| 首问 | 返回 `sessionId`，列表出现「P0 故障谁指挥…」标题 |
| 消息数 | 2 条（user + assistant），assistant 带 `sources` |
| 追问 | 同 sessionId，消息数变 4 |
| 空召回 | 也落库（标题覆盖、消息 2 条） |
| 别人的会话 | 404 |
| 删除 | 会话与消息一起消失 |

## 主动回忆

1. **为什么用 `ON DELETE CASCADE`？什么时候不该用？**
   子记录不能独立存在（会话/消息）→ 建外键 + 级联，删主表自动清理不留孤儿。审计/日志类必须留痕 → 不建外键，改业务层校验。

2. **`sources` 为什么用 JSONB 而不是关联表？**
   引用是"整块快照"（index/title/excerpt/score 一起读），结构会演进；按整体读写更自然。代价：无法按片段反查、不能建普通索引。

3. **空召回为什么也写库？**
   用户看到的是"没答上来"，但运营需要知道哪些问题没覆盖（召回缺口分析）。这是**产品观测**需求，不是功能需求。

4. **首屏加载顺序为什么是 me → sessions → messages？**
   先确定身份才能查"我的"会话；有会话才能查消息。顺序反了会 401 或查空。

## 关联

- [[61-AI问答对话历史]] —— 课程精读
- [[60-前端界面与前后端联调]] —— 上一讲
- 前一篇：`docs/前端界面与前后端联调v12总结.md`
