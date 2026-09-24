declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    QUARANTINE_RETENTION_DAYS?: string;
    PLATFORM_ADMIN_EMAILS?: string;
    PLATFORM_APPROVER_EMAILS?: string;
    PLATFORM_AUDITOR_EMAILS?: string;
    CONFIG_ENCRYPTION_KEY?: string;
    // 域账号（LDAP bind）登录：
    // ALLOW_SELF_DECLARED_LOGIN 显式覆盖「自声明登录」开关（仅联调可设 true）；
    // LOGIN_MAX_FAILURES / LOGIN_LOCK_MINUTES 为失败锁定策略。
    ALLOW_SELF_DECLARED_LOGIN?: string;
    LOGIN_MAX_FAILURES?: string;
    LOGIN_LOCK_MINUTES?: string;
  }
}
