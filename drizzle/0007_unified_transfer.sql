-- 0007 单平台文件收发改造（需求变更定稿，见 UNIFIED-TRANSFER-EVAL.md §8）
-- 1) applications 增加 kind：legacy_external=旧架构外发（归档只读）；transfer=站内文件发送
-- 2) 新增 application_recipients：站内收件人（域账号，一个发送单可多个收件人）
-- 3) 重建 download_deliveries：删除匿名外链机制相关列（download_url/token_hash/expires_at/max_downloads/
--    external_object_key/deleted_at），保留留痕字段；存量旧交付记录保留为归档数据（recipient 字段置空）
-- 4) 删除 recipients 表：接收方不再由管理员手工维护，统一来自 LDAP 目录（ldap_users）

ALTER TABLE applications ADD COLUMN kind TEXT NOT NULL DEFAULT 'legacy_external';

CREATE TABLE application_recipients (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  department TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX application_recipients_application_idx ON application_recipients (application_id);
CREATE INDEX application_recipients_email_idx ON application_recipients (email);

CREATE TABLE download_deliveries_v2 (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  recipient_email TEXT,
  recipient_name TEXT,
  file_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  download_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  first_downloaded_at TEXT,
  last_downloaded_at TEXT,
  revoked_at TEXT
);
INSERT INTO download_deliveries_v2 (id, application_id, recipient_email, recipient_name, file_name, enabled, download_count, created_at, first_downloaded_at, last_downloaded_at, revoked_at)
SELECT id, application_id, NULL, NULL, file_name, enabled, download_count, created_at, first_downloaded_at, last_downloaded_at, revoked_at
FROM download_deliveries;
DROP TABLE download_deliveries;
ALTER TABLE download_deliveries_v2 RENAME TO download_deliveries;
CREATE INDEX download_deliveries_application_idx ON download_deliveries (application_id);
CREATE INDEX download_deliveries_recipient_idx ON download_deliveries (recipient_email);

DROP TABLE recipients;
