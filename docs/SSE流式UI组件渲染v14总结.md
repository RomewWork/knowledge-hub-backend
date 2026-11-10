---
type: course-summary
status: done
course: 62
module: SSE 流式 UI 组件渲染
code_base:
  - ai-agent-code/knowledge/knowledge-hub-backend
  - ai-agent-code/knowledge-hub-frontend
tags:
  - 课程总结
  - SSE
  - 流式
  - AI SDK
  - Agent
related:
  - "[[61-AI问答对话历史]]"
  - "[[62-SSE流式UI组件渲染]]"
---

# SSE 流式 UI 组件渲染 v14 总结

> 课程 62 · 后端 `knowledge-hub-backend`（v14）· 前端 `knowledge-hub-frontend`（v14）
> 整理时间：2026-11-11

## 一句话

**从「一次性返回」升级为「Agent 流式输出，过程可渲染」**：后端用 AI SDK 的 UI Message Stream 协议把会话、检索、来源、思考、工具调用、正文都写成带类型的事件；前端 `useChat` 消费 part 并分派到不同卡片。

同时是**从固定 pipeline 到 Agent** 的转折：模型自己决定「知识库够不够、要不要联网」。

## 与 v13 的差异

| 维度 | v13 | v14 |
|---|---|---|
| 传输 | 一次性 JSON | SSE（UI Message Stream） |
| 生成 | `llm.invoke()` | `createAgent` + 工具 + 中间件 |
| 外部能力 | 仅知识库 | + `web_search`（Bocha） |
| 前端 | 等完整结果 | `useChat` 边收边渲染 |
| 过程可见 | 只有 loading | 检索状态 / 思考链 / 来源卡 / 联网卡 |
| 检索质量 | rerank 后直接 topK | + `RAG_MIN_SCORE=0.4` 过滤 |
| 落库 | 请求结束同步写 | `onFinish` 里写（流结束后） |

## 新增依赖

| 端 | 包 | 作用 |
|---|---|---|
| 后端 | `ai@^7` | `createUIMessageStream` / `pipeUIMessageStreamToResponse` |
| 后端 | `@ai-sdk/langchain@^3` | LangChain 流 → UI Message Stream |
| 后端 | `langchain@^1.5` | `createAgent` / `tool` / middleware |
| 后端 | `@langchain/core@^1.2.9` | 升级（适配包依赖新字段） |
| 前端 | `ai@^7` + `@ai-sdk/react@^4` | `DefaultChatTransport` / `useChat` |

> `ai` 版本**前后端必须一致**，否则 part 结构对不上、界面空白。

## 环境变量

```bash
RAG_MIN_SCORE=0.4          # rerank 分下限；0 表示不过滤
# LLM_ENABLE_THINKING=true # qwen 思考模式
# BOCHA_API_KEY=           # 不配则 web_search 返回提示（不报错）
```

## 协议：UI Message Stream

一次流式问答的事件顺序（实测）：

```
start
 └ data-session         { sessionId }
 └ data-status          { stage:'retrieve', text:'正在检索知识库…' }
 └ data-retrieve        { query, items[] }
 └ data-sources         sources[]
 └ source-document ×N   { sourceId, mediaType, title }
 └ start-step
 └ reasoning-start/delta/end     （思考）
 └ text-start / text-delta ×N   （正文）
 └ finish
```

**协议只规定"事件长什么样"，不含业务**——会话、检索、来源都要在 `execute` 里自己写。

## 后端核心：`ai-stream.service.ts`（349 行）

### 1. 构造期：Agent

```
ChatOpenAI（temperature 0.2 / maxRetries 0 / streamUsage false / enable_thinking 可选）
  → createAgent({
      model,
      tools: [web_search],
      systemPrompt: 优先知识库、不足再联网、[n] 对齐、不编造,
      middleware: [modelCallLimitMiddleware({ runLimit: 4, exitBehavior: 'end' })],
    })
```

两个关键取舍：

- **工具永不抛错**：没配 key / 请求失败都返回「带 error 的结果对象」，抛错会打断 Agent 循环；
- **`runLimit: 4` + `exitBehavior: 'end'`**：防模型反复调搜索，超限正常收尾而不是报错。

### 2. `streamChat()`：手写编排

```
writer.write({ type:'start' })
① 取最后一条 user 消息文本（从 parts 拼）
② 建/取会话 → data-session
③ data-status(retrieve)
④ retrieval.retrieve()（失败只 warn，hits 保持空）
⑤ data-retrieve / data-sources / source-document×N
⑥ agent.stream({ streamMode:['messages','tools'] })
   → writer.merge(toUIMessageStream(mapReasoningStream(...), { sendStart:false, sendFinish:false }))
```

**为什么不是直接 return agent.stream()**：外层已经写了会话/检索等业务事件，要把「业务事件流」和「模型 token 流」合并成一条 SSE。

**为什么要关 `sendStart/sendFinish`**：start/finish 的所有权在外层，重复发会让前端状态机错乱（气泡被切成两段）。

### 3. `onFinish`：落库

```
从 responseMessage.parts 里拼 text → answer
正则抽 [n] → 只保留被引用的 sources
sessions.appendTurn(userId, sessionId, question, answer, sources)
失败只 warn
```

**为什么在 `onFinish`**：只有流结束才能拿到完整答案。
**为什么失败只 warn**：答案已经流完、用户已经看到了，此时报错只会让人困惑。

### 4. 思考链转换

`mapReasoningStream` + `attachDashScopeReasoning`：把百炼兼容口的 `additional_kwargs.reasoning_content` 改写成适配包认的 `reasoning.summary`。
不转 → 前端永远没有思考块。

### 5. 检索阈值（`hybrid-retrieval`）

```
rerank(query, fused, fused.length)   ← 先不截断
  → minScore 过滤
  → slice(topK)
```

**为什么先过滤再截**：先截 topK 再过滤可能一条不剩；先过滤能保证"够用就用满"。
日志会打 `kept`，方便调阈值。

### 6. reranker 兼容

```ts
const results = body.output?.results ?? body.results ?? [];
```

DashScope 不同版本结构不一致；不兼容的后果是**精排静默失效**（返回 null → 降级 RRF），很难发现。

## 前端核心

### `useChat` + `DefaultChatTransport`

- `api: '/api/ai/chat/stream'`，`headers` 用**函数**形式（token 刷新后仍有效）；
- `body` 带 `sessionId / topK`；
- 返回 `messages / status / stop / error`，UI 直接用。

### `ChatMessageParts`（342 行，新组件）

流式下"消息"不是字符串，而是 part 序列，按 `part.type` 分派：

| part.type | 渲染 |
|---|---|
| `text` | 正文（打字机） |
| `reasoning` / `data-think` | 可折叠思考块 |
| `data-status` | 进度提示 |
| `data-retrieve` | 检索卡（query + 命中） |
| `data-sources` | 来源列表 |
| `source-document` | 单条来源锚点 |
| `source-url` | 联网结果链接 |
| `step-start` / `data-session` | 不渲染 |

辅助：`sourcesFromParts` / `textFromParts` / `citedSources` / `historyToUIMessages`。

**`historyToUIMessages` 必须存在**：DB 存 `{role,content,sources}`，`useChat` 只认 `parts`——不转换，刷新后历史空白。

### `SourceCiteList` 升级

从"展示列表"变成"引用跳转系统"：

- `citeAnchorId` 生成锚点；
- `injectCites` 把 Markdown 里的 `[n]` 变成可点 chip（保留 Markdown 结构，不是纯文本替换）；
- `focusCite` 点击滚动 + 高亮；
- `AnswerMarkdown` 用 `react-markdown` 渲染注入后的内容。

### `vite.config`

| 改动 | 原因 |
|---|---|
| `timeout/proxyTimeout: 0` | 代理默认超时会切断 SSE，表现为"答到一半没了" |
| `target: 127.0.0.1` | Node 18+ 下 `localhost` 可能解析成 IPv6 `::1`，后端只监听 IPv4 |
| `host: true` | 允许局域网/容器访问 |

## 改动清单（18 个文件）

| 端 | 文件 | 改动 |
|---|---|---|
| 后端 | `src/ai/ai-stream.service.ts` | **新增 349 行**：流式编排 + Agent + 落库 |
| 后端 | `src/ai/web-search.service.ts` | 新增 93 行：Bocha 搜索 |
| 后端 | `src/ai/dto/chat-stream.dto.ts` | 新增 42 行：useChat 请求体（放宽额外字段） |
| 后端 | `src/ai/ai.controller.ts` | +16：`POST /ai/chat/stream` |
| 后端 | `src/ai/ai.module.ts` | +4：注册两个 service |
| 后端 | `src/ai/chat-session.service.ts` | +9：`touchTitle` |
| 后端 | `src/ai/hybrid-retrieval.service.ts` | +14/−2：`RAG_MIN_SCORE` |
| 后端 | `src/ai/reranker.service.ts` | +4/−2：兼容两种响应 |
| 后端 | `.env.example` / `package.json` | 新变量 / 新依赖 |
| 前端 | `src/components/ChatMessageParts.tsx` | **新增 342 行**：按 part 渲染 |
| 前端 | `src/pages/ChatPage.tsx` | +151/−112：改用 `useChat` |
| 前端 | `src/components/SourceCiteList.tsx` | +156/−29：引用锚点与跳转 |
| 前端 | `src/index.css` | +303：流式/思考/卡片样式 |
| 前端 | `vite.config.ts` | +4/−1：SSE 代理 |
| 前端 | `package.json` | +2：`ai` / `@ai-sdk/react` |

## 易错点

| 坑 | 说明 |
|---|---|
| SSE 被代理攒包 | Vite 设 `timeout:0`；生产 Nginx 要 `proxy_buffering off` + `X-Accel-Buffering: no` |
| 重复 start/finish | `sendStart:false, sendFinish:false` |
| `@Res()` 后不能 throw | 异常要写 `error` part，否则前端只看到断流 |
| `ai` 版本不一致 | 前后端都要 7.x |
| `useChat` 只认 parts | 存 `content` 字段会被忽略 |
| 历史空白 | 缺 `historyToUIMessages` 转换 |
| 检索失败冒泡 | 整个 SSE 断流；必须 try/catch 只 warn |
| `maxRetries` 非 0 | 流式重试会让前端收到重复 delta（半截话重复） |
| **`maxRetries: 0` 的代价** | 偶发网络失败即整条流失败，需前端可重试 |
| 工具死循环 | 必须 `modelCallLimitMiddleware` |
| `data-session` 不幂等 | 每次重渲染都 `navigate`，路由抖动 |
| `RAG_MIN_SCORE` 过高 | 全部过滤 → 空上下文 → 只会答"不知道" |
| `localhost` vs `127.0.0.1` | IPv6 解析导致代理连不上后端 |

## 验收

```bash
# 直接看 SSE 原始流（-N 关缓冲）
curl -N -X POST localhost:3000/ai/chat/stream \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","parts":[{"type":"text","text":"P0 故障谁指挥？"}]}],"topK":5}'
```

| 检查点 | 期望 |
|---|---|
| 首字延迟 | 明显低于 v13（先出 status 与来源） |
| 打字机 | 正文逐字出现 |
| 思考块 | 开 thinking 时有折叠区 |
| 联网 | 问时效问题触发 `web_search`，出现链接卡 |
| 停止 | 点「停止」能中断 |
| 刷新 | 历史完整（含 sources） |
| 落库 | 只存被引用的 sources |
| 阈值 | 调高 `RAG_MIN_SCORE` 后日志 `kept` 变小 |

## 主动回忆

1. **SSE 与 WebSocket 怎么选？**
   只需服务端→浏览器单向推送 → SSE：普通 HTTP、过代理、自动重连。双向交互/低延迟指令 → WebSocket。

2. **为什么要 `writer.merge` 而不是直接返回 Agent 流？**
   Agent 流只有模型 token，不含业务事件（会话、检索进度、来源）。必须先写业务事件，再把 token 流合并进同一条 SSE。

3. **关掉 `sendStart/sendFinish` 会怎样？**
   外层已发 start；内层再发一次 → 前端把一条消息切成两段，或状态机卡在"已完成/生成中"之间。

4. **检索失败为什么不能抛？**
   抛异常会让整条 SSE 断开，用户看到空白。正确做法：warn + `hits=[]` + prompt 改「知识库没有召回」，让模型仍能回答（或明说没有）。

5. **流式落库为什么比非流式难？**
   非流式有完整 response 对象；流式只有 parts 序列，要自己拼 text、抽引用、判断哪些 sources 真被用到，且失败不能影响已发送的答案。

## 关联

- [[62-SSE流式UI组件渲染]] —— 课程精读
- [[61-AI问答对话历史]] —— 上一讲
- 前一篇：`docs/AI问答对话历史v13总结.md`
