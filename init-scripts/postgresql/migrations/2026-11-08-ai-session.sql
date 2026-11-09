-- =====================================================================
-- 增量迁移：AI 会话（v13 / 课程 61）
--
-- 背景：init-scripts/postgresql/init.sql 只在「数据目录为空」的首次初始化
--       时由 postgres 镜像执行；库已有数据时它不会再跑，所以新增表必须
--       用本文件手动补一次。
--
-- 特性：全部 IF NOT EXISTS，可重复执行（幂等）。
--
-- 执行方式（在 knowledge-hub-backend 目录下）：
--   PowerShell:
--     Get-Content .\init-scripts\postgresql\migrations\2026-11-08-ai-session.sql -Raw |
--       docker exec -i knowledge_hub_postgres psql -U user -d knowledge_hub
--   Git Bash / WSL:
--     docker exec -i knowledge_hub_postgres psql -U user -d knowledge_hub \
--       < init-scripts/postgresql/migrations/2026-11-08-ai-session.sql
--
-- 执行后校验：
--   docker exec -it knowledge_hub_postgres psql -U user -d knowledge_hub -c "\dt kh_ai_*"
-- =====================================================================

BEGIN;

-- AI 会话：一次对话一行
CREATE TABLE IF NOT EXISTS kh_ai_session (
    id BIGINT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    title VARCHAR(80) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 会话列表按「人 + 最近更新」查，走这个索引
CREATE INDEX IF NOT EXISTS idx_kh_ai_session_user_updated
    ON kh_ai_session(user_id, updated_at DESC);

-- AI 消息：一问一答各一行；sources 存引用快照（JSON 结构随 ChatSource 演进）
CREATE TABLE IF NOT EXISTS kh_ai_message (
    id BIGINT PRIMARY KEY,
    session_id BIGINT NOT NULL REFERENCES kh_ai_session(id) ON DELETE CASCADE,
    role VARCHAR(16) NOT NULL,
    content TEXT NOT NULL,
    sources JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 回看某会话时按时间取，同毫秒用 id 兜底
CREATE INDEX IF NOT EXISTS idx_kh_ai_message_session_id
    ON kh_ai_message(session_id, created_at);

COMMIT;
