import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const applications = sqliteTable("applications", {
  id: text("id").primaryKey(),
  fileName: text("file_name").notNull(),
  extension: text("extension").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  requesterId: text("requester_id").notNull(),
  requesterEmail: text("requester_email"),
  requesterName: text("requester_name").notNull(),
  department: text("department").notNull(),
  recipientId: text("recipient_id").notNull(),
  recipientName: text("recipient_name").notNull(),
  description: text("description").notNull(),
  status: text("status").notNull(),
  ruleId: text("rule_id").notNull(),
  ruleName: text("rule_name").notNull(),
  objectKey: text("object_key"),
  sha256: text("sha256"),
  decisionReason: text("decision_reason"),
  approverId: text("approver_id"),
  approverEmail: text("approver_email"),
  assignedApprovers: text("assigned_approvers"),
  // 内容类型防伪装（0009）：上传时嗅探首 512 字节魔数与声明后缀比对
  detectedKind: text("detected_kind"),
  detectedExtensions: text("detected_extensions"),
  typeMismatch: integer("type_mismatch", { mode: "boolean" }),
  contentSignature: text("content_signature"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("applications_status_idx").on(table.status),
  index("applications_created_at_idx").on(table.createdAt),
]);

export const rules = sqliteTable("rules", {
  id: text("id").primaryKey(),
  priority: integer("priority").notNull(),
  name: text("name").notNull(),
  extensions: text("extensions").notNull(),
  minSizeBytes: integer("min_size_bytes"),
  maxSizeBytes: integer("max_size_bytes"),
  action: text("action").notNull(),
  scope: text("scope").notNull(),
  approverEmails: text("approver_emails"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("rules_priority_idx").on(table.priority)]);

// 站内收件人：文件发送单的接收方为域账号（来自 LDAP 目录），一个发送单可对应多个收件人。
// 0007 起替代旧的 recipients 表（外部交付配置），接收人不再由管理员手工维护。
export const applicationRecipients = sqliteTable("application_recipients", {
  id: text("id").primaryKey(),
  applicationId: text("application_id").notNull(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  department: text("department"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("application_recipients_application_idx").on(table.applicationId),
  index("application_recipients_email_idx").on(table.email),
]);

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  at: text("at").notNull(),
  actorId: text("actor_id").notNull(),
  actorEmail: text("actor_email"),
  actorDisplay: text("actor_display").notNull(),
  action: text("action").notNull(),
  objectId: text("object_id").notNull(),
  result: text("result").notNull(),
  detail: text("detail"),
  previousHash: text("previous_hash"),
  hash: text("hash").notNull(),
}, (table) => [
  index("audit_events_at_idx").on(table.at),
  index("audit_events_object_idx").on(table.objectId),
]);

export const ldapSyncRuns = sqliteTable("ldap_sync_runs", {
  id: text("id").primaryKey(),
  status: text("status").notNull(),
  summary: text("summary").notNull(),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at"),
  actorId: text("actor_id").notNull(),
});

export const ldapUsers = sqliteTable("ldap_users", {
  // email 列即「身份标识」：优先邮箱；目录无邮箱时用域账号（sAMAccountName/uid）或 DN
  email: text("email").primaryKey(),
  // account：域账号（sAMAccountName/uid），用于「用域账号登录」时反查身份。
  // 历史同步数据（0007 之前）为空，登录成功后按目录属性回填。
  account: text("account"),
  employeeId: text("employee_id"),
  name: text("name").notNull(),
  department: text("department"),
  ouPath: text("ou_path"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  lastSyncedAt: text("last_synced_at").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  index("ldap_users_department_idx").on(table.department),
  index("ldap_users_active_idx").on(table.active),
  index("ldap_users_account_idx").on(table.account),
]);

// 登录失败计数与锁定（0008）：按登录标识（域账号或邮箱，小写）聚合，
// 达到阈值后锁定一段时间，避免域账号被在线爆破。登录成功即清零。
export const loginAttempts = sqliteTable("login_attempts", {
  identifier: text("identifier").primaryKey(),
  lastIp: text("last_ip"),
  failureCount: integer("failure_count").notNull().default(0),
  firstFailureAt: text("first_failure_at"),
  lastFailureAt: text("last_failure_at"),
  lockedUntil: text("locked_until"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("login_attempts_locked_until_idx").on(table.lockedUntil)]);

export const integrationSettings = sqliteTable("integration_settings", {
  id: text("id").primaryKey(),
  // Redmine 风格直连认证源：名称/主机/端口/LDAPS；bindDn=帐号，encryptedSecret=密码（加密存储）
  ldapName: text("ldap_name"),
  ldapHost: text("ldap_host"),
  ldapPort: integer("ldap_port"),
  ldapLdaps: integer("ldap_ldaps", { mode: "boolean" }).notNull().default(false),
  // 搜索过滤器（如 (objectClass=user)），缺省为 (objectClass=person) 只匹配用户类对象
  ldapFilter: text("ldap_filter"),
  // 旧版 HTTP LDAP 网关地址（保留作回退；直连主机未配置时生效）
  ldapGatewayUrl: text("ldap_gateway_url"),
  baseDn: text("base_dn"),
  bindDn: text("bind_dn"),
  encryptedSecret: text("encrypted_secret"),
  syncIntervalMinutes: integer("sync_interval_minutes").notNull().default(30),
  // 内容类型防伪装策略开关（0009）：normal=不一致拒绝+未知转人工；strict=一律拒绝；off=仅记录
  contentTypeGuard: text("content_type_guard").notNull().default("normal"),
  // 内网 SMTP 发信配置（0010）：均可空 = 未启用邮件通知；密码加密存储同 encryptedSecret
  smtpHost: text("smtp_host"),
  smtpPort: integer("smtp_port"),
  // 隐式 TLS（通常 465）；false=明文/STARTTLS（通常 25/587）
  smtpSecure: integer("smtp_secure", { mode: "boolean" }).notNull().default(false),
  smtpFrom: text("smtp_from"),
  smtpUsername: text("smtp_username"),
  smtpEncryptedSecret: text("smtp_encrypted_secret"),
  updatedAt: text("updated_at").notNull(),
});

// 发件队列（0010）：通知先入队再异步发送，失败不阻断主流程，可在 attempts 上限内重试。
// kind：APPROVAL_PENDING（审批待办）/ DELIVERED（收件通知）/ TEST（管理员测试发送）
export const mailOutbox = sqliteTable("mail_outbox", {
  id: text("id").primaryKey(),
  applicationId: text("application_id"),
  kind: text("kind").notNull(),
  toAddress: text("to_address").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  sentAt: text("sent_at"),
}, (table) => [
  index("mail_outbox_status_idx").on(table.status),
  index("mail_outbox_application_idx").on(table.applicationId),
]);

export const roleAssignments = sqliteTable("role_assignments", {
  email: text("email").primaryKey(),
  displayName: text("display_name").notNull(),
  role: text("role").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("role_assignments_role_idx").on(table.role)]);

// 送达记录：审批通过后按收件人各生成一条，收件人登录平台后经 /api/files/{id}（会话鉴权）下载。
export const downloadDeliveries = sqliteTable("download_deliveries", {
  id: text("id").primaryKey(),
  applicationId: text("application_id").notNull(),
  recipientEmail: text("recipient_email"),
  recipientName: text("recipient_name"),
  fileName: text("file_name").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  downloadCount: integer("download_count").notNull().default(0),
  createdAt: text("created_at").notNull(),
  firstDownloadedAt: text("first_downloaded_at"),
  lastDownloadedAt: text("last_downloaded_at"),
  revokedAt: text("revoked_at"),
}, (table) => [
  index("download_deliveries_application_idx").on(table.applicationId),
  index("download_deliveries_recipient_idx").on(table.recipientEmail),
]);

// 下载事件表：内部下载（DOWNLOAD_INTERNAL）与撤回（REVOKE）的统一审计视图，全部由平台本地写入。
export const downloadEvents = sqliteTable("download_events", {
  id: text("id").primaryKey(),
  deliveryId: text("delivery_id"),
  applicationId: text("application_id").notNull(),
  event: text("event").notNull(),
  ip: text("ip"),
  userAgent: text("user_agent"),
  result: text("result").notNull(),
  reason: text("reason"),
  createdAt: text("created_at").notNull(),
}, (table) => [
  index("download_events_delivery_idx").on(table.deliveryId),
  index("download_events_application_idx").on(table.applicationId),
  index("download_events_created_at_idx").on(table.createdAt),
]);
