-- =====================================================================
-- v21 产品体验完善：分类 / 评论 / 点赞 / 收藏 / 分享 / 版本 / 通知
--
-- 背景：init.sql 只在空数据卷首次启动时执行，已有库不会自动补表，
--       所以这里单独提供增量脚本（全部幂等，可重复执行）。
--
-- 执行方式（容器内）：
--   docker exec -i knowledge_hub_postgres psql -U user -d knowledge_hub \
--     -f /docker-entrypoint-initdb.d/migrations/2026-11-18-product-experience.sql
-- 或在客户端里整段执行。
-- =====================================================================

BEGIN;

-- ---------------- 1. 分类 ----------------
CREATE TABLE IF NOT EXISTS kh_category (
    id BIGINT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    parent_id BIGINT NOT NULL DEFAULT 0,
    sort INT NOT NULL DEFAULT 0,
    description VARCHAR(500),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    deleted BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_kh_category_parent ON kh_category(parent_id);

-- ---------------- 2. 评论 ----------------
CREATE TABLE IF NOT EXISTS kh_comment (
    id BIGINT PRIMARY KEY,
    document_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    user_name VARCHAR(50) NOT NULL,
    content VARCHAR(2000) NOT NULL,
    parent_id BIGINT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    deleted BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_kh_comment_document ON kh_comment(document_id);

-- ---------------- 3. 点赞 ----------------
CREATE TABLE IF NOT EXISTS kh_document_like (
    id BIGINT PRIMARY KEY,
    document_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (document_id, user_id)
);

-- ---------------- 4. 收藏 ----------------
CREATE TABLE IF NOT EXISTS kh_document_favorite (
    id BIGINT PRIMARY KEY,
    document_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (document_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_kh_document_favorite_user ON kh_document_favorite(user_id);

-- ---------------- 5. 分享链接 ----------------
-- 已发布文档的分享链接；过期或已关闭后不可访问
CREATE TABLE IF NOT EXISTS kh_document_share (
    id BIGINT PRIMARY KEY,
    document_id BIGINT NOT NULL,
    token VARCHAR(64) NOT NULL UNIQUE,
    created_by BIGINT NOT NULL,
    expire_at TIMESTAMP,
    revoked BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    require_password BOOLEAN NOT NULL DEFAULT false,
    password_hash VARCHAR(255)
);
CREATE INDEX IF NOT EXISTS idx_kh_document_share_document ON kh_document_share(document_id);

-- ---------------- 6. 文档版本 ----------------
CREATE TABLE IF NOT EXISTS kh_document_version (
    id BIGINT PRIMARY KEY,
    document_id BIGINT NOT NULL,
    version INT NOT NULL,
    title VARCHAR NOT NULL,
    content TEXT NOT NULL,
    summary VARCHAR,
    created_by BIGINT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (document_id, version)
);
CREATE INDEX IF NOT EXISTS idx_kh_document_version_document
    ON kh_document_version(document_id, version DESC);

-- ---------------- 7. 站内通知 ----------------
CREATE TABLE IF NOT EXISTS kh_notification (
    id BIGINT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    type VARCHAR(20) NOT NULL,
    title VARCHAR(100) NOT NULL,
    content VARCHAR(2000),
    document_id BIGINT,
    sender_id BIGINT,
    sender_name VARCHAR(50),
    is_read BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kh_notification_user
    ON kh_notification(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kh_notification_unread
    ON kh_notification(user_id) WHERE is_read = false;

-- ---------------- 8. 种子数据：默认分类 ----------------
INSERT INTO kh_category (id, name, parent_id, sort, description) VALUES
    (7000000000000000001, '制度规范', 0, 1, '公司制度与流程'),
    (7000000000000000002, '技术文档', 0, 2, '设计、接口与实现说明'),
    (7000000000000000003, '操作手册', 0, 3, '操作步骤与排障')
ON CONFLICT (id) DO NOTHING;

-- ---------------- 9. 种子数据：新增权限码 ----------------
INSERT INTO kh_permission (id, parent_id, permission_name, permission_code, permission_type, sort) VALUES
    (4000000000000000016, 4000000000000000002, '分类管理', 'document:category', 2, 6),
    (4000000000000000019, 4000000000000000002, '分类查询', 'document:category:query', 2, 7),
    (4000000000000000017, 4000000000000000002, '文档版本', 'document:version', 2, 8)
ON CONFLICT (permission_code) DO NOTHING;

-- ---------------- 10. 给管理员授权（否则新功能按钮不出现） ----------------
INSERT INTO kh_role_permission (id, role_id, permission_id)
SELECT 4100000000000000101, r.id, p.id
FROM kh_role r, kh_permission p
WHERE r.role_code = 'ROLE_ADMIN' AND p.permission_code = 'document:category'
ON CONFLICT DO NOTHING;

INSERT INTO kh_role_permission (id, role_id, permission_id)
SELECT 4100000000000000102, r.id, p.id
FROM kh_role r, kh_permission p
WHERE r.role_code = 'ROLE_ADMIN' AND p.permission_code = 'document:category:query'
ON CONFLICT DO NOTHING;

INSERT INTO kh_role_permission (id, role_id, permission_id)
SELECT 4100000000000000103, r.id, p.id
FROM kh_role r, kh_permission p
WHERE r.role_code = 'ROLE_ADMIN' AND p.permission_code = 'document:version'
ON CONFLICT DO NOTHING;

COMMIT;
