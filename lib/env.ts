// 运行时环境变量访问器（Node 标准运行时）。
//
// 历史背景：本项目原先跑在 Cloudflare Workers 上，环境变量只能经 Worker 绑定
// （`import { env } from "cloudflare:workers"`）读取。局域网自托管场景不需要边缘运行时，
// 改用 Next.js 标准 Node 服务器后，所有配置统一来自 process.env。
//
// 约定：
//   - 空字符串视为「未配置」（与 Worker 绑定的语义一致，`env.X === "false"` 之类的判断不受影响）；
//   - 用 Proxy 惰性读取，不做模块级快照 —— 避免构建期被内联成常量；
//   - 不在此处做类型转换，调用方按需 Number()/Boolean() 转换（保持与旧代码同样的宽容度）。
//
// 变量清单见 .env.docker.example 与 DEVELOPMENT.md「生产变量」一节。

export type PlatformEnv = {
  // ---------- 数据与运行目录 ----------
  /** 数据根目录：数据库、文件、备份都落在这里（容器内为 /data） */
  DATA_DIR?: string;
  /** 覆盖数据库文件绝对路径（默认 <DATA_DIR>/db/platform.db） */
  DB_FILE?: string;
  /** 覆盖文件存储目录（默认 <DATA_DIR>/files） */
  FILES_DIR?: string;
  /** 覆盖迁移文件目录（默认 <cwd>/drizzle） */
  MIGRATIONS_DIR?: string;
  /** 监听端口（standalone server.js 读取） */
  PORT?: string;
  HOSTNAME?: string;

  // ---------- 业务配置 ----------
  /** 会话签名 + LDAP 密码加密密钥。上线后不可轮换。 */
  CONFIG_ENCRYPTION_KEY?: string;
  /** 平台管理员名单（逗号分隔）。配置后本地兜底登录与自声明登录一并失效。 */
  PLATFORM_ADMIN_EMAILS?: string;
  PLATFORM_APPROVER_EMAILS?: string;
  PLATFORM_AUDITOR_EMAILS?: string;
  /** 已拒绝/已驳回文件的隔离区保留天数（默认 7） */
  QUARANTINE_RETENTION_DAYS?: string;
  /** 自声明登录开关（仅联调可 true） */
  ALLOW_SELF_DECLARED_LOGIN?: string;
  /** 登录失败锁定阈值（默认 5 次 / 15 分钟） */
  LOGIN_MAX_FAILURES?: string;
  LOGIN_LOCK_MINUTES?: string;

  /** 允许任意其它键（便于渐进迁移与脚本自定义变量） */
  [key: string]: string | undefined;
};

export const env: PlatformEnv = new Proxy({} as PlatformEnv, {
  get(_target, key) {
    if (typeof key !== "string") return undefined;
    const value = process.env[key];
    return value === undefined || value === "" ? undefined : value;
  },
  has(_target, key) {
    if (typeof key !== "string") return false;
    const value = process.env[key];
    return value !== undefined && value !== "";
  },
});
