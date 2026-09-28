# 文件安全收发平台

内网（可离线）文件安全收发审批平台：**提交文件 → 规则判定 → 审批 → 站内送达 → 收件人下载留痕**，
全链路可审计。设计目标是「一台机器、一个进程、一个数据目录就能跑起来」，不依赖任何云服务。

- 域账号登录走 **LDAP 直连**（AD / OpenLDAP），密码只用于当次 bind，不落库、不进审计。
- 上传是**流式**的：内存占用与文件大小无关；落盘同时计算 SHA-256，下载时可校验。
- **内容防伪装**：按文件首部魔数嗅探真实类型，与声明后缀不符即拒绝（详见 `CONTENT-TYPE-GUARD.md`）。
- 收件人只能在「审批通过且送达」之后下载；发起人可撤回，撤回后立即失效。

## 技术栈

| 关注点 | 选型 | 说明 |
| --- | --- | --- |
| 运行时 | **Node.js ≥ 22.13** | 单进程标准 Node 服务器，无边缘运行时、无 workerd |
| 应用框架 | **Next.js 16（App Router）** | `output: "standalone"`，生产只需 `node server.js` |
| 数据库 | **SQLite（Node 内置 `node:sqlite`）+ Drizzle ORM** | 零原生依赖、零 ABI 风险；库文件显式落在数据目录 |
| 文件存储 | **本地文件系统** | 按 objectKey 落盘，保留 R2 风格接口形态（`put/get/delete/list`） |
| 目录认证 | **ldapts** | 成熟的 LDAP 客户端，取代历史上手写的 BER 编解码 |
| 部署 | 本地脚本 / Docker Compose | 单镜像、三阶段构建、运行阶段不装任何依赖 |

> 历史沿革：本项目原跑在 Cloudflare Workers（vinext 构建 + wrangler/workerd + D1/R2 绑定）。
> 因交付形态是局域网自托管、且不出网，已整体迁移到上面的标准 Node 栈。

## 快速开始

### 1) 本地开发（带 HMR）

```bash
npm install
npm run db:migrate     # 幂等：按 drizzle/*.sql 建库/补迁移
npm run dev            # http://127.0.0.1:8787
```

### 2) 本地按生产形态跑一遍

```bash
npm run local:setup    # 装依赖（首次）+ 初始化数据库
npm run local:start    # 产物过期会自动重建 → 迁移 → 起服务
```

`local:start` 跑的是 `.next/standalone/server.js`，与容器里的启动方式**完全一致**；
数据默认落在仓库根的 `.local-data/`（可用 `DATA_DIR` 覆盖）。

### 3) Docker Compose

```bash
cp .env.docker.example .env.docker   # 至少填 CONFIG_ENCRYPTION_KEY（别覆盖根 .env，那是本地开发用的）
docker compose --env-file .env.docker up -d --build         # 平台 + 备份 sidecar
docker compose --env-file .env.docker --profile dev up -d   # 额外带一个测试用 LDAP（生产请连真实 AD）
# 或用内置 npm 脚本（已带 --env-file）：npm run docker:up / npm run docker:up:dev
```

详见 `DOCKER-DEPLOYMENT.md`。

## 数据布局

所有状态都在一个目录下（容器内是 `/data` 卷，本地是 `.local-data/`）：

```
<DATA_DIR>/db/platform.db      SQLite 主库（WAL）
<DATA_DIR>/files/…             隔离区对象（按 objectKey 落盘，同名 .meta.json 存 content-type）
<DATA_DIR>/backups/            备份产物（数据库快照 + 文件增量镜像）
```

备份用 SQLite 官方在线备份 API（`node:sqlite` 的 `backup()`），**不停服、不漏 WAL**：

```bash
npm run backup                          # 备份到 <DATA_DIR>/backups
node scripts/backup.mjs --no-files      # 只备数据库
node scripts/backup.mjs --keep 30       # 数据库保留最近 30 份
node scripts/backup.mjs --out /mnt/bak  # 输出到备份盘
```

容器里由 `backup` sidecar 周期调用（`BACKUP_INTERVAL_SECONDS` / `BACKUP_KEEP`）。

### 数据目录的解析规则（容易踩）

`standalone` 的 `server.js` 开头会 `process.chdir(__dirname)`，所以「相对路径」是按**应用根**解析的，
不是按进程当前目录 —— 见 `lib/paths.ts` 的 `anchorRoot()`。目的是防止误把数据写进 `.next/`
（下一次 `next build` 会整体清空，数据会被一起删掉）。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `CONFIG_ENCRYPTION_KEY` | ✅ | 会话签名 + LDAP 密码加密；**上线后不可轮换** |
| `PLATFORM_ADMIN_EMAILS` | 生产必填 | 配了就只剩 LDAP 一条登录路径，本地兜底登录同时失效 |
| `PLATFORM_APPROVER_EMAILS` / `PLATFORM_AUDITOR_EMAILS` | | 角色名单（逗号分隔） |
| `DATA_DIR` | | 数据根目录，默认 `<应用根>/.local-data`（容器里为 `/data`） |
| `DB_FILE` / `FILES_DIR` / `MIGRATIONS_DIR` | | 分别覆盖库文件、文件目录、迁移目录 |
| `PORT` / `HOSTNAME` | | 监听地址，默认 `3000` / `0.0.0.0`；本地脚本固定 8787 / 127.0.0.1 |
| `QUARANTINE_RETENTION_DAYS` | | 被拒/被驳回文件的隔离区保留天数，默认 7 |
| `ALLOW_SELF_DECLARED_LOGIN` | | 自声明登录开关，**仅联调可 true** |
| `LOGIN_MAX_FAILURES` / `LOGIN_LOCK_MINUTES` | | 登录失败锁定，默认 5 次 / 15 分钟 |
| `LDAP_PAGE_SIZE` | | 搜索分页每页条目数，默认 500；`0` 关闭分页 |
| `LDAP_TLS_REJECT_UNAUTHORIZED` | | LDAPS 严格校验证书，自签名内网 AD 保持 `false` |

`.env` 只在**本地**被读取（`next dev` 自动加载；`npm start` 等脚本用 `node --env-file-if-exists=.env`）。
容器内的配置全部来自 Compose 的环境变量注入，镜像里不含 `.env`。

## 健康检查

| 路径 | 语义 | 行为 |
| --- | --- | --- |
| `/healthz` | 存活 | 不碰任何依赖，只要进程能响应就 200。失败 → **重启容器** |
| `/readyz` | 就绪 | 查 SQLite 可读写 + 存储目录可写。失败 → **摘流量**（503） |

两者刻意分开：用「查库」当存活探针时，数据库短暂不可用会被误判成进程死了，导致容器反复重启、放大故障。
`/readyz` **不主动连 LDAP** —— 目录暂时不可达时平台本身仍可用，不该把整个实例判为未就绪。

## 启动前自检与应急恢复

平台启动时会先跑一次自检，把「配置错误」提前暴露出来，而不是等到使用者登录失败才发现：

```bash
npm run preflight     # 检查密钥是否缺失/仍是占位符、数据目录是否可写、
                      # 以及「配了管理员名单却没有认证源」这种会导致完全无法登录的死局
```

容器里由 `docker/entrypoint-platform.sh` 自动调用 —— 自检不通过会**阻止启动**并打印原因与改法
（紧急情况可用 `SKIP_PREFLIGHT=1` 绕过）。这样问题的表现形式是「容器起不来 + 明确原因」，
而不是「登录莫名其妙失败」。

万一真的把自己锁在门外（换过密钥导致口令解不开、LDAP 不可达、角色丢了），用下面这个工具诊断和恢复。
它直接读写数据目录里的 SQLite，**不依赖服务进程**，平台起不来时照样能用：

```bash
npm run admin:inspect                              # 诊断：当前到底有哪几条登录路径
node scripts/reset-admin.mjs --clear-ldap --yes    # 清空坏掉的认证源配置
node scripts/reset-admin.mjs --grant you@corp.local
```

完整恢复流程（含顺序陷阱）见 `DOCKER-DEPLOYMENT.md` §9.5「锁死后如何恢复」。

## 代码检查

```bash
npm run verify    # lint + typecheck + PowerShell 编码约定
```

`.ps1` 脚本必须保持 **UTF-8 BOM + CRLF** —— Windows PowerShell 5.1 在没有 BOM 时会按系统 ANSI
代码页解读，中文字符串会乱码，甚至让 Parser 直接报语法错（历史上真的这么废掉过一个脚本）。
这条约定由 `npm run check:encoding` 强制，CI 同样会跑。

## 回归测试

平台需已启动（脚本会真实写数据，**只能打开发/验收环境**）：

| 命令 | 覆盖 | 用例数 |
| --- | --- | --- |
| `node scripts/check-sha256.mjs` | 增量 SHA-256 与 Node crypto 一致 | 11 |
| `node scripts/e2e-internal-transfer.mjs --mock-ldap` | 提交 → 审批 → 送达 → 下载 → 撤回 全闭环 | 29 |
| `node scripts/verify-content-type.mjs --mock-ldap` | 内容防伪装（TC-01~TC-12） | 26 |
| `node scripts/smoke-test.mjs --write` | 接口契约 + 可见性口径 | 26 |
| `node scripts/test-ldap-login.mjs` | 配认证源 → 同步 → 登录 → 锁定 | 18 |

`--mock-ldap` 会自动把认证源临时指向本地 mock LDAP（先起 `node scripts/mock-ldap-server.mjs --port 3890`），
跑完**自动还原**原配置。mock 目录约定：**普通用户口令 = 账号名**。

## 目录结构

```
app/                    页面与 API 路由（App Router）
  api/…                 业务接口
  healthz/ readyz/      探针
components/ hooks/      UI
lib/
  env.ts                运行时环境变量访问器（process.env）
  paths.ts              数据目录解析唯一真相
  storage.ts            本地文件系统「对象桶」（替代 R2）
  upload.ts             流式落盘 + 增量 SHA-256
  ldap-client.ts        LDAP 直连（ldapts）
  server.ts             规则引擎、可见性、状态机
db/
  schema.ts             Drizzle schema
  index.ts              打开库 + 首次访问即迁移
  sqlite-client.mjs     node:sqlite → better-sqlite3 接口适配（纯 ESM，CLI 复用）
  migrations.mjs        迁移执行器（目录清单驱动、幂等）
  better-sqlite3.mjs    模块名兼容层（构建别名用，见 next.config.ts）
drizzle/               迁移 SQL（0000-0003, 0005-0009；编号 0004 历史上被跳过）
scripts/               迁移 CLI、备份、组装 standalone、各回归脚本
docker/                Dockerfile.platform / entrypoint / 测试用 LDAP 镜像
```

## 更多文档

- `DEVELOPMENT.md` —— 架构细节、关键实现约定、历史坑位
- `DOCKER-DEPLOYMENT.md` —— 镜像构建、卷、备份 sidecar、排障
- `LOCAL-DEPLOYMENT.md` —— 本地开发与生产形态本地运行
- `PROD-DEPLOYMENT.md` —— 生产部署与运维
- `CONTENT-TYPE-GUARD.md` —— 内容防伪装策略与验收用例

## 许可证

本项目采用 [MIT 许可证](LICENSE) —— 可自由使用、修改、分发，包括商业用途，只需保留版权声明。

第三方资源：`vendor/` 下的样式文件来自 shadcn/tailwind 生态，其许可条款见
`vendor/shadcn-tailwind-4.13.0.LICENSE.md`。
