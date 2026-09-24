-- 0008：域账号登录（LDAP bind）
--
-- 背景：0007 之前登录是「自声明邮箱」，任何人填别人的邮箱即可冒充（统一收发场景下等于可
-- 任意以他人名义收发文件）。本迁移为「域账号 + 域密码」登录补齐持久化支撑。
--
-- 1) ldap_users.account：保存域账号（sAMAccountName/uid）。历史数据只有邮箱或 DN，
--    该列为空；登录成功后按目录实际属性回填，之后即可用域账号直接定位身份。
ALTER TABLE ldap_users ADD COLUMN account TEXT;

CREATE INDEX IF NOT EXISTS ldap_users_account_idx ON ldap_users (account);

-- 2) login_attempts：登录失败计数与锁定。放在库里而非内存，是因为 workerd 实例可能随时
--    重建，内存计数等于没有防爆破。阈值与锁定时长可用环境变量覆盖（见 lib/login-guard.ts）。
CREATE TABLE IF NOT EXISTS login_attempts (
  identifier TEXT PRIMARY KEY,
  last_ip TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  first_failure_at TEXT,
  last_failure_at TEXT,
  locked_until TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS login_attempts_locked_until_idx ON login_attempts (locked_until);
