# 本地部署与联调手册（不装 Docker）

> 面向开发/联调：在一台机器上把平台跑起来、造出可登录的测试账号、跑回归。
> 生产与容器部署见 `PROD-DEPLOYMENT.md` / `DOCKER-DEPLOYMENT.md`；架构见 `DEVELOPMENT.md`。
>
> **2026-09-24 起运行时是标准 Node**（Next standalone 的 `node server.js`）。
> 旧版依赖 `vinext build` + `wrangler dev --local --persist-to %TEMP%\transfer-platform-state`
> 的说法已作废 —— 不再需要任何 `--persist-to`，数据目录由 `DATA_DIR` 明确指定。

## 1. 前置

- Node.js **≥ 22.16**（用到内置的 `node:sqlite`，无需任何原生模块编译；下限具体到 22.16 是因为
  用到了该版本才提供的 `sqlite.backup()` 与 `setReturnArrays()` —— 依据见 `db/runtime.mjs`）。
- 无需 Docker、无需 wrangler、无需全局包。

## 2. 两种跑法

### 2.1 开发模式（热更，日常改代码用这个）

```bash
npm install
npm run db:migrate      # 幂等：按 drizzle/*.sql 建库/补迁移
npm run dev             # next dev，本机 http://127.0.0.1:8787（next dev 默认也监听所有网卡）
```

`next dev` 会**自动加载** `.env`。

### 2.2 生产形态（验证「上线后到底怎么跑」）

```bash
npm run local:setup     # 装依赖（首次）+ 初始化数据库
npm run local:start     # 产物过期自动重建 → 迁移 → 起 .next/standalone/server.js
```

`local:start` 跑的就是容器里跑的那个文件（`.next/standalone/server.js`），
端口固定 `8787`、默认监听所有网卡（内网同事可用本机 IP 访问；设 `HOSTNAME=127.0.0.1` 可收回本机），
所以「本地能跑」与「容器能跑」的差异面被压到最小。

> `.next/standalone/server.js` 不会自己加载 `.env`（只有 `next dev` 会），
> 所以脚本用 `node --env-file-if-exists=.env` 显式喂进去。
> 该参数**不覆盖**已存在的真实环境变量，文件不存在时静默跳过 —— 容器里就是这种情况。

> 让内网同事访问：需要以管理员身份运行 `scripts/open-lan-access.ps1` 放行 Windows 防火墙 8787
>（原理与回滚方式见脚本头注释）。`npm run dev` 默认监听所有网卡，同样适用。

## 3. 数据目录

默认落在**仓库根** `.local-data/`（可用 `DATA_DIR` 覆盖）：

```
.local-data/db/platform.db     SQLite 主库（WAL，含 -wal/-shm）
.local-data/files/…            隔离区对象
.local-data/backups/           备份产物
```

**为什么按「仓库根」而不是进程当前目录解析**：standalone 的 `server.js` 开头会
`process.chdir(__dirname)`（即 `.next/standalone`）。若按 cwd 落数据，数据会进 `.next/`，
下一次 `next build` 清空 `.next` 时被一起删掉。`lib/paths.ts` 的 `anchorRoot()` 专门处理这件事。

想换位置：在 `.env` 里写 `DATA_DIR=D:/platform-data`（相对路径按仓库根解析，建议写绝对路径）。

## 4. 造一个可登录的测试账号

本地联调推荐用 **mock LDAP**（不需要真目录）：

```bash
# 终端 A：起 mock 目录（普通用户口令 = 账号名）
node scripts/mock-ldap-server.mjs --port 3890

# 终端 B：起平台
npm run local:start
```

然后在页面上用兜底管理员进入「LDAP 与权限」，把认证源指向 `127.0.0.1:3890`
（Base DN `dc=example,dc=local`，绑定帐号 `cn=admin,dc=example,dc=local`，密码随便填非空），
保存后点「目录同步」。mock 目录里有 `zhangsan` / `lisi` / `wangwu` / `zhaoliu`，
用账号名当口令即可登录。

> 更省事的办法：直接跑 `node scripts/test-ldap-login.mjs` 或
> `node scripts/e2e-internal-transfer.mjs --mock-ldap`，它们会自动完成上面的配置并**跑完还原**。
> 全新实例上库里还没有 LDAP 绑定密码，脚本会自动写入一个占位口令。

**两条登录路径的区别**：
- 未配置 `PLATFORM_ADMIN_EMAILS` → 登录页有「本地管理员」兜底入口，且允许自声明邮箱登录（联调态）。
- 配置了 `PLATFORM_ADMIN_EMAILS` → 兜底与自声明**同时失效**，只剩「域账号 + 域密码」。

## 5. 回归脚本

| 命令 | 覆盖 | 用例数 |
|---|---|---|
| `node scripts/check-sha256.mjs` | 流式哈希自检（不需要服务） | 11 |
| `node scripts/e2e-internal-transfer.mjs --mock-ldap` | 提交 → 审批 → 送达 → 下载 → 撤回 | 29 |
| `node scripts/verify-content-type.mjs --mock-ldap` | 内容防伪装（TC-01~TC-12） | 26 |
| `node scripts/smoke-test.mjs` + 三角色账号与口令 + `--write` | 接口契约 + 可见性 | 26 |
| `node scripts/test-ldap-login.mjs` | 配认证源 → 同步 → 登录 → 锁定 | 18 |
| `node scripts/test-rekey.mjs` | 密钥轮换全路径（**不写真实数据**，可随时跑） | 40 |

- 这些脚本会**真实写入**数据，只对本地/验收环境跑（`test-rekey.mjs` 例外，它自带临时空库）。
- 口令默认取账号名（mock 约定），可用 `--requester-password` 等参数覆盖。
- `test-ldap-login.mjs` 的失败锁定用例会把 `zhaoliu` 锁 15 分钟，**放最后跑**。
- `--mock-ldap` 需要 mock LDAP 已在 3890 监听。

## 6. 常用维护命令

```bash
npm run db:migrate                     # 迁移
node scripts/migrate.mjs --status      # 只打印已应用/待应用清单
npm run backup                         # 数据库热备 + 文件增量镜像
node scripts/backup.mjs --no-files     # 只备数据库
npm run local:reset                    # 重置演示数据（清业务表，保留迁移记录）
```

停掉本地服务：执行 `scripts/stop-dev-server.ps1`（按 `server.js` / `next` 特征找进程，
并释放 8787 端口；需要管理员权限）。

## 7. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `EADDRINUSE: address already in use 127.0.0.1:8787` | 已有实例（可能是容器）占着端口。先看 `docker ps`，或跑停服脚本 |
| 登录 422「请输入域密码」 | 认证源配好了但库里没有绑定密码，或请求没带密码。重新保存一次认证源（填上密码） |
| 登录 400「认证源缺少：绑定密码」 | 同上；全新库常见，跑一次 `test-ldap-login.mjs` 或手工保存一次即可 |
| 同步出来的人没有姓名/部门 | 目录没回属性值。已由 `returnAttributeValues: true` 保证；若改过 `lib/ldap-client.ts` 请核对这一项 |
| 数据"莫名消失" | 大概率是 `DATA_DIR` 指到了 `.next/` 下；用 `/readyz` 看 `runtime.dataDir` 实际值 |
| `ExperimentalWarning: SQLite is an experimental feature` | 预期噪音，`node:sqlite` 目前是实验特性 |
| 改了 `.ps1` 后中文乱码 | 必须存成 **UTF-8 BOM + CRLF** |
