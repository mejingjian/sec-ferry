-- 0009：内容类型防伪装 + 移除历史外发归档
-- 1) 归档下线：删除 legacy_external 存量数据并移除 kind 列
--    （audit_events 哈希链只增不改，历史审计事件完整保留，本迁移只清理业务表）
DELETE FROM download_deliveries WHERE application_id IN (SELECT id FROM applications WHERE kind = 'legacy_external');
DELETE FROM application_recipients WHERE application_id IN (SELECT id FROM applications WHERE kind = 'legacy_external');
DELETE FROM applications WHERE kind = 'legacy_external';
ALTER TABLE applications DROP COLUMN kind;

-- 2) 内容类型防伪装（CONTENT-TYPE-GUARD.md）：上传时嗅探首 512 字节魔数，
--    与声明后缀比对，落库判定依据供审批与审计复核。
ALTER TABLE applications ADD COLUMN detected_kind TEXT;
ALTER TABLE applications ADD COLUMN detected_extensions TEXT;
ALTER TABLE applications ADD COLUMN type_mismatch INTEGER;
ALTER TABLE applications ADD COLUMN content_signature TEXT;

-- 3) 策略开关：normal=不一致拒绝+未知转人工（默认）；strict=不一致与未知一律拒绝；off=仅记录不影响判定
ALTER TABLE integration_settings ADD COLUMN content_type_guard TEXT NOT NULL DEFAULT 'normal';
