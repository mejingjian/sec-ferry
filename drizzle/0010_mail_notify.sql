-- 0010：邮件通知（需求 ⑥：审批待办通知 + 收件通知，内网 SMTP）
-- 设计要点：
--   * SMTP 配置挂在 integration_settings（与 LDAP 认证源同一行 id='ldap'），
--     密码加密存储口径与 LDAP 绑定密码一致（AES-GCM，密钥 = SHA-256(CONFIG_ENCRYPTION_KEY)）。
--   * 发送失败不阻断主流程：先落 mail_outbox（待发），由 processMailOutbox 异步消费；
--     失败保留记录与错误信息，可重试（attempts 上限内）。

-- 1) SMTP 发信配置（均可空 = 未配置邮件功能）
ALTER TABLE integration_settings ADD COLUMN smtp_host TEXT;
ALTER TABLE integration_settings ADD COLUMN smtp_port INTEGER;
-- 隐式 TLS（通常 465）；0=明文/STARTTLS（通常 25/587）
ALTER TABLE integration_settings ADD COLUMN smtp_secure INTEGER NOT NULL DEFAULT 0;
-- 发件人地址（必填项，如 transfer-platform@corp.local）
ALTER TABLE integration_settings ADD COLUMN smtp_from TEXT;
-- 认证帐号（内网中继若免认证可留空）与密码密文
ALTER TABLE integration_settings ADD COLUMN smtp_username TEXT;
ALTER TABLE integration_settings ADD COLUMN smtp_encrypted_secret TEXT;

-- 2) 发件队列表：审批待办（APPROVAL_PENDING）、收件通知（DELIVERED）、测试邮件（TEST）
CREATE TABLE mail_outbox (
  id TEXT PRIMARY KEY,
  application_id TEXT,
  kind TEXT NOT NULL,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);
CREATE INDEX mail_outbox_status_idx ON mail_outbox (status);
CREATE INDEX mail_outbox_application_idx ON mail_outbox (application_id);
