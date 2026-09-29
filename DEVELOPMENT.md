# 文件安全收发平台（transfer-approval-platform）开发维护文档

> 最后更新：2026-09-24（Node 自托管重构完成）｜适用版本：当前主干
>
> 本文档面向后续接手开发/维护的工程师，覆盖架构、目录、环境搭建、核心模块、测试与已知坑。
> 部署细节另见 `LOCAL-DEPLOYMENT.md`（本地）、`DOCKER-DEPLOYMENT.md`（容器）、`PROD-DEPLOYMENT.md`（生产）、
> `CONTENT-TYPE-GUARD.md`（内容防护专项）。
>
> **2026-09-24 重大变更**：运行时已从 Cloudflare Workers（vinext + wrangler/workerd + D1/R2 绑定）
> 整体迁移到标准 Node 自托管。旧运行时相关文件已移出仓库到本地归档目录（未删除，可回滚），
> 重构前的安全快照是 git commit `026258f`。

---

## 1. 项目定位与总体架构

局域网内使用的**文件安全收发与审批平台**，单平台单库单数据目录，**不出网**
（原"交付网关/历史外发"功能已于 2026-09-22 整体移除，`DELIVERY_*`/`GATEWAY_*` 变量作废）。

```
浏览器 (React SPA, App Router)
   │  fetch /api/*
   ▼
Node 服务器（Next.js 16 standalone 的 server.js，单进程）
   ├── SQLite（Node 内置 node:sqlite）：业务数据 + 审计链   → <DATA_DIR>/db/platform.db
   ├── 本地文件系统：文件对象（按 objectKey 落盘）           → <DATA_DIR>/files/
   ├── integration_settings 表（加密存储）：LDAP 认证源配置
   └── LDAP 直连（ldapts）：域账号认证 + 目录同步
```

核心闭环：**提交文件 → 规则引擎判定 → 自动通过即送达 / 待审批 → 审批通过后送达 →
收件人下载（逐人记录 download_deliveries）→ 全程审计（哈希链）**。

---

## 2. 技术栈

| 层 | 技术 | 版本 |
|---|---|---|
| 运行时 | **Node.js**（单进程标准 HTTP 服务器） | ≥ 22.13（`node:sqlite` 需要 22.5+） |
| 框架 | Next.js（App Router, RSC），`output: "standalone"` | 16.3.4 |
| 构建 | Next 内置 Turbopack | — |
| ORM | Drizzle ORM + drizzle-kit | 0.45.2 / 0.31.10 |
| 数据库 | **`node:sqlite`**（Node 内置）经 Drizzle 的 `better-sqlite3` 驱动 | — |
| 文件存储 | 本地文件系统（`lib/storage.ts`，接口形态对齐 R2） | — |
| LDAP | **ldapts** | 9.2.0 |
| UI | Tailwind CSS 4 + radix-ui + lucide-react + cva/clsx/tailwind-merge | — |

**关键约束**：
- **改代码必须重新构建**（`npm run build`），再重启 `server.js`；运行期没有编译步骤。
- 生产启动方式只有一种：`node .next/standalone/server.js`。**没有** wrangler / workerd / `dist/`。
- `.next/standalone` 是自包含产物（server.js + 最小 node_modules + static + public + drizzle），
  Dockerfile 只 COPY 这一个目录。

---

## 3. 目录结构

```
app/                      # Next.js App Router
├── page.tsx              # 主页面（SPA 视图切换 + mapApplication 数据映射）
├── login/                # 登录页
├── healthz/ readyz/      # 存活 / 就绪探针
└── api/                  # 全部 REST API（见 §7）
components/
├── ui/                   # 基础组件（shadcn 风格），2026-09-24 已瘦身到 13 个；
│                         # 需要新组件用 `npx shadcn@latest add <name>` 重新引入
└── views/                # 业务视图（Dashboard/Submit/Applications/Approvals/Inbox/Audit/Rules/Ldap…）
lib/
├── env.ts                # 运行时环境变量访问器（Proxy over process.env，空串视为未配置）
├── paths.ts              # 数据目录解析「唯一真相」（含 standalone chdir 的处理，见 §15）
├── storage.ts            # 本地文件系统对象桶（put/get/delete/list/head）
├── upload.ts             # 流式落盘 + 增量 SHA-256（putStreamWithDigest）
├── ldap-client.ts        # LDAP 直连（ldapts）
├── ldap-config.ts        # 认证源配置读取/解密（登录与同步共用，避免两套口径）
├── server.ts             # 服务端主逻辑：规则引擎、可见性、状态机
├── visibility.ts         # 唯一可见性判定入口
├── file-type.ts          # 魔数嗅探（纯函数）
├── content-guard.ts      # 内容防伪装策略层
├── sha256.ts             # 流式哈希
├── session.ts / login-guard.ts / ldap-user.ts
db/
├── schema.ts             # Drizzle 表定义
├── index.ts              # 打开库 + 首次访问即迁移 + 单例
├── sqlite-client.mjs     # node:sqlite → better-sqlite3 接口适配（纯 ESM，CLI 复用）
├── migrations.mjs        # 迁移执行器（目录清单驱动、幂等）+ ensureParentDir
└── better-sqlite3.mjs    # 模块名兼容层（构建别名目标，见 next.config.ts）
drizzle/                  # 迁移 SQL：0000-0003, 0005-0009（无 0004，历史跳号）+ meta/
scripts/                  # 迁移 CLI、备份、组装 standalone、mock LDAP、各回归脚本
docker/                   # Dockerfile.platform、entrypoint-platform.sh、ldap/（Dockerfile.ldap + seed.ldif）
docker-compose.yml        # platform + backup sidecar + ldap（--profile dev）
```

---

## 4. 本地开发环境

```powershell
npm install
npm run db:migrate          # 幂等建库/补迁移（可单独跑）
npm run dev                 # next dev，端口 8787，改代码热更
npm run local:setup         # 首次：装依赖 + 初始化数据库
npm run local:start         # 按生产形态跑：产物过期自动重建 → 迁移 → 起 server.js
npm run build               # next build + 组装 standalone
npm run local:reset         # 重置演示数据
```

- **数据目录**：仓库根 `.local-data/`（可用 `DATA_DIR` 覆盖）。容器里是 `/data` 卷。
- `.env` **只在本地被读取**：`next dev` 由 Next 自动加载；`npm start` / `db:migrate` / `backup`
  等脚本用 `node --env-file-if-exists=.env` 显式加载。容器内配置全部来自 Compose 环境变量。
- 新增/修改 `.ps1` 必须 **UTF-8 BOM + CRLF**，否则中文与换行都会损坏。

---

## 5. 核心模块（lib/）

| 文件 | 职责 | 注意事项 |
|---|---|---|
| `server.ts` | 服务端主逻辑：会话、规则引擎 `evaluateFileDetailed()`、提交/审批/送达 pipeline、`storage()` 单例 | preview 与提交共用同一引擎，勿复制逻辑 |
| `visibility.ts` | **唯一**可见性判定入口 | 任何"我能看到哪些单"的查询都必须走它，不得另写过滤 |
| `paths.ts` | 数据目录解析 | `anchorRoot()` 处理 standalone 的 chdir；相对路径按**应用根**解析 |
| `storage.ts` | 本地对象桶 | 先写临时文件再原子改名；文件名 `..` 穿越已拦；`.meta.json` 存 content-type |
| `upload.ts` | 流式落盘 + 哈希 | 内存与文件大小无关；落盘后校验实际字节数 == Content-Length |
| `file-type.ts` | 文件首 512B 魔数嗅探（纯函数，无 IO） | |
| `content-guard.ts` | 内容类型防伪装策略层（见 §10） | |
| `sha256.ts` | 流式哈希 | **禁用 `arrayBuffer()`**（大文件爆内存），必须流式 |
| `session.ts` / `login-guard.ts` | 会话与登录失败锁定 | 锁定记录在 `login_attempts` 表（非内存），锁定返回 429。勿用「lockedUntil 空 ⇒ 已过期」判断（踩过坑） |
| `ldap-client.ts` | LDAP 直连（ldapts） | 搜索必须 `returnAttributeValues: true`（等价旧实现的 `typesOnly=FALSE`）。历史上写错值会让 openldap 只回属性名、值全空，导致同步出"DN 当邮箱"的坏用户；mock 目录忽略该标志所以本地从未暴露 |
| `ldap-config.ts` / `ldap-user.ts` | 认证源配置（加密存储）、目录用户 | 登录与同步**共用**同一份解密/组装逻辑 |
| `mail.ts` | 内网 SMTP 邮件通知（0010）：审批待办 + 收件通知 | 手写最小 SMTP 客户端（node:net/tls，**零新依赖**，npm 只能 `--offline` 装不了 nodemailer）。业务路径只入队 `mail_outbox`，`dispatchMailOutbox()` 后台消费，失败不阻断主流程；密码加密同 LDAP（AES-GCM） |

---

## 6. 数据模型与迁移

12 张表（`db/schema.ts`）：

| 表 | 用途 |
|---|---|
| `applications` | 发送单。含内容防护字段 `detected_kind` / `detected_extensions` / `type_mismatch` / `content_signature`（0009 引入，同时删了旧 `kind` 列与归档数据） |
| `rules` | 审批规则（见 §11） |
| `application_recipients` | 站内收件人（0007 起替代旧外发表，收件人来自 LDAP 域账号） |
| `audit_events` | 审计链（previous_hash/hash 哈希链，防篡改） |
| `download_deliveries` | 逐收件人送达记录；`first_downloaded_at` 即"已读"凭据（**不建已读表**） |
| `download_events` | 下载事件流水 |
| `ldap_users` / `ldap_sync_runs` | LDAP 目录快照与同步记录 |
| `login_attempts` | 登录失败锁定 |
| `integration_settings` | 集成配置（LDAP 认证源、contentTypeGuard 开关、SMTP 发信配置 smtp_*（0010）等，加密存储） |
| `role_assignments` | 角色分配（管理员/审批人/审计员） |
| `mail_outbox` | 邮件发件队列（0010）：pending/sent/failed + attempts 重试计数；SMTP 未配置时通知只入队暂存，配置后自动发出 |

**迁移规范（已大幅简化，务必按新流程）**：

- 执行器 = `db/migrations.mjs`：列出 `drizzle/` 下所有 `*.sql`，按文件名排序，逐条在
  `__platform_migrations` 表登记，**已登记则跳过**（幂等）。
- 应用与 CLI 共用同一份逻辑：`db/index.ts`（首次 `getDb()` 时自动迁移）与
  `scripts/migrate.mjs`（`npm run db:migrate`）都调它。
- 新增迁移：改 `db/schema.ts` → `npm run db:generate` → 完成。
  **不再需要**改任何 `--files` 清单，**也不再需要** marker 文件
  （旧的 `.transfer-platform-schema-vN` 与 `docker/entrypoint-platform.sh` / `local-setup.ps1`
  两处硬编码清单已随重构废除；编号不连续也不影响，执行器对 0004 缺失不做假设）。
- `drizzle/meta/_journal.json` 不参与执行器，仅 drizzle-kit 自己用。

---

## 7. API 一览

```
POST /api/auth/login | /api/auth/logout        GET /api/auth/me
GET  /api/bootstrap                            # 首屏聚合：可见单 + recipients/deliveries（inArray 过滤），
                                               # 并补超窗口的「发给我」单据
POST /api/applications?fileName=&recipients=   # body=文件字节流；规则引擎→自动通过即送达/待审批
GET  /api/applications
POST /api/applications/[id]/decision           # 审批通过/驳回；发起人回避校验（管理员豁免）
POST /api/applications/[id]/revoke             # 撤回：本人 + 管理员/审批人（勿用 requireApprover，否则发起人 403）
POST /api/applications/[id]/transfer           # 转办
GET  /api/files/[id]                           # 下载（鉴权见 §9）
GET/PUT /api/admin/config                      # PUT 认证源字段名是 secret（LDAP bind 密码）
GET/PUT/POST /api/admin/mail-config            # SMTP 配置读写（secret=SMTP 密码）；POST=测试发送并补发积压队列
GET/POST /api/admin/roles                      # 角色分配
GET/POST /api/rules ; GET/PUT/DELETE /api/rules/[id] ; POST /api/rules/preview
POST /api/ldap/sync ; POST /api/ldap/test-bind
GET  /api/audit/export                         # 审计导出
POST /api/admin/cleanup                        # 清理
GET  /healthz                                  # 存活探针（不碰依赖）
GET  /readyz                                   # 就绪探针（查库 + 存储可写）
```

---

## 8. 认证与角色

**登录契约**（`lib/login-guard.ts` + `ldap-client.ts`）：
1. LDAP 模式：服务帐号 bind → 搜索用户 DN（域账号/邮箱/UPN/uid/cn 任一命中）→ 用户 DN + 密码重新 bind。
2. 搜不到且输入不像 DN ⇒ 直接失败（防账号枚举；不区分"无此账号"与"密码错"）。
3. 服务帐号自身配错（密码过期/被禁用）必须原样抛给管理员，**不被兜底路径掩盖**。
4. 密码**不落库、不进审计**。
5. 本地兜底 `{local:true}`：仅在未配置 `PLATFORM_ADMIN_EMAILS` 时可用；自声明用户仅联调态。
6. 失败锁定：`LOGIN_MAX_FAILURES`(默认5) 次 / `LOGIN_LOCK_MINUTES`(15)，记录在库内；锁定返回 429。

**角色**：管理员（`PLATFORM_ADMIN_EMAILS`，生产必配——配了之后只剩 LDAP 登录）、审批人、审计员，
存 `role_assignments`，管理页可配。

**审批回避（职责分离）**：`decision` 接口校验——`角色≠管理员` 且 `requesterEmail==actor.email` → 403
「不能审批自己提交的发送单」。**管理员权限完全放开，可自批**。提交时 `assignedApprovers` 剔除发起人
（剔除后为空回退管理员）；前端 `ApprovalsView` 对本人单显示"本人提交，需他人审批"徽章。

---

## 9. 收发闭环与关键流程

1. **提交** `POST /api/applications?fileName=&recipients=`（body 为文件字节）：
   - 缓冲前 512B 做魔数嗅探（`bufferPrefix` + `file-type.ts`）→ 内容防护判定（`content-guard.ts`，见 §10）
   - 规则引擎判定：自动通过 → 直接进送达 pipeline；否则 `status=待审批`，`assignedApprovers` 已剔除发起人
   - 落库 `detected_kind/detected_extensions/type_mismatch/content_signature`
2. **审批**：通过后走与自动通过相同的 pipeline，逐收件人写 `download_deliveries`。
3. **邮件通知（0010，`lib/mail.ts`）**：转人工审批时给指派审批人（未指派则「审批人」角色名单 + `PLATFORM_APPROVER_EMAILS`，剔除发起人）发审批待办邮件；送达后给各收件人发收件通知。只入队不阻塞：SMTP 未配置/发送失败只影响 `mail_outbox` 行状态（失败重试至 5 次、3 天截止），管理员测试发送接口会顺带补发积压。SMTP 配置在管理页「内网 SMTP 发信」卡片，密码 AES-GCM 加密；自签名中继可设 `SMTP_TLS_REJECT_UNAUTHORIZED=0`。回归：`scripts/test-mail-notify.mjs`（含内嵌 mock SMTP）。
4. **下载** `files/[id]` 鉴权顺序：
   - 本人 / 管理员 / 审计员 / 被指派审批人 → 放行
   - 收件人 → 须满足：单据 `TRANSFERRED` + 该收件人送达 enabled + 未撤回；
     否则返回明确原因 `NOT_DELIVERED` / `DELIVERY_REVOKED` / `FORBIDDEN`
5. **撤回**：本人 + 管理员/审批人。
6. **收件箱角标**：走 NavGroup badges；"已读"以 `first_downloaded_at` 为凭据，无已读表。
7. **错误路径先排空请求体再响应**（`failWithStream`）：这样对端能拿到完整错误响应而不是被复位连接。
   （历史上是为规避 workerd 对上传流 `cancel()` 导致的 worker 瞬断，迁移到 Node 后仍保留此写法。）

---

## 10. 内容类型防伪装（CONTENT-TYPE-GUARD.md）

**定稿语义（勿改动）**：
- 声明后缀 ≠ 内容魔数 → **403 拒绝**
- 未知类型：`normal` 档转人工审批 / `strict` 档拒绝 / `off` 仅记录
- 开关在**管理页 `contentTypeGuard`**（integration_settings 表，guardOnly 局部更新），**不是环境变量**

能力边界：只防"改后缀不改内容"，转码/截图类伪装防不了。

---

## 11. 规则引擎

字段：`extensions` / `minSize` / `maxSize`（字节，UI 展示用 MB）/ `action` / `scope` / `approverEmails` /
`priority`（数字小者先匹配）。

**常见误配**：「最小 1MB」写反方向会让所有小文件落入 R-FALLBACK 转人工。判定逻辑唯一入口
`lib/server.ts evaluateFileDetailed()`，规则预览（`/api/rules/preview`）与提交共用。

---

## 12. 测试与回归脚本（scripts/）

> 除 `test-rekey.mjs` 外都是**真实写入**的回归，只允许打开发/验收环境，禁止对生产执行。
> （`test-rekey.mjs` 用全新空库 + 人造密文演练，不碰真实数据，可随时跑。）

| 脚本 | 内容 | 备注 |
|---|---|---|
| `e2e-internal-transfer.mjs` | 29 项收发闭环（容器侧 25 项） | `--mock-ldap` 自动切/还原配置；默认不同步目录 |
| `smoke-test.mjs` | 26 项冒烟 | 需 `--write` + 三角色账号口令 |
| `verify-content-type.mjs` | 26 项内容防护 | 收件人可用 `E2E_RECIPIENT_EMAIL` 环境变量回退 |
| `test-ldap-login.mjs` | 18 项 LDAP 登录 | **zhaoliu 会触发锁定 15 分钟**，别频繁跑 |
| `check-sha256.mjs` | 11 项流式哈希自检 | |
| `test-rekey.mjs` | 40 项密钥轮换：只读审计/计划/旧密钥错误拒绝/正式轮换+快照+复核/往返/格式契约/审计链连续性 | **不写真实数据**（建临时空库并自动清理）；`npm run test:rekey` |
| `test-mail-notify.mjs` | 邮件通知闭环（SMTP 配置/测试发送/故障不阻断/积压补发/审批+收件通知） | 内嵌 mock SMTP（127.0.0.1:2525）；容器实例默认 `--smtp-host host.docker.internal`，本地实例传 `127.0.0.1`；结束自动还原邮件配置 |
| `mock-ldap-server.mjs` | 本地 mock LDAP | `node scripts/mock-ldap-server.mjs --port 3890`，口令=账号名 |
| `migrate.mjs` | 迁移 CLI | `--status` 只打印已应用/待应用 |
| `backup.mjs` | 数据库热备 + 文件增量镜像 | `--no-files` / `--keep N` / `--out DIR` |

**测试账号与口令（两套，勿混用）**：
- 容器 `--profile dev` 的 openldap（389，seed.ldif）：口令 `Passw0rd!<账号名>`
- 本地 mock（3890）：口令 = 账号名
- 账号：`zhangsan`(管理员) / `wangwu`(审批人) / `lisi`、`zhaoliu`(发起人)

**2026-09-24 重构后实测基线（全绿）**：
本地 standalone —— e2e 29/29 + content-type 26/26 + smoke 26/26 + ldap-login 18/18 + sha256 11/11；
容器（`--profile dev`，真实 openldap）—— e2e 25/25 + smoke 26/26 + backup sidecar 正常。

---

## 13. Docker 部署要点（详见 DOCKER-DEPLOYMENT.md）

```bash
cp .env.docker.example .env.docker   # CONFIG_ENCRYPTION_KEY 随机 32 字节 hex（备份勿提交）
                                     # 容器读 .env.docker；根 .env 只给本地 dev 用，两者密钥不共用
npm run docker:build && npm run docker:up:dev    # dev profile 才含测试用 LDAP 容器
npm run docker:smoke
```

三阶段单镜像（deps → builder → runtime），**运行阶段不装任何包**，只 COPY `.next/standalone` +
`db/*.mjs`/`scripts/*.mjs`（让启动前迁移能 fail-fast）；`/data` 三卷（db/files/backups）；
`backup` sidecar 复用同镜像循环跑 `backup.mjs`（备份产物写完即校验，见该脚本 `verifyBackup`）；
非 root uid 10001 + 只读根 FS + `cap_drop ALL` + `no-new-privileges`；HEALTHCHECK 打 `/healthz`。

容器内配置链路（首启手工配一次）：先用兜底 `local:true` 登录 → PUT `/api/admin/config`
指向 `ldap:389`（字段名 `secret`）→ POST `/api/ldap/sync` → 管理页配角色。

**LDAP 种子只在空卷首启导入**：改种子后需 `docker compose rm -sf ldap` + 删 `ldap-data`/`ldap-config`
两卷（**勿 `down -v`**，会连平台数据一起删）+ `--build` 重建。

---

## 14. 生产部署关键变量

| 变量 | 说明 |
|---|---|
| `CONFIG_ENCRYPTION_KEY` | integration_settings 加密 + 会话签名。**可轮换**：`npm run rekey`（加解密实现与轮换工具共用 `db/crypto.mjs`） |
| `PLATFORM_ADMIN_EMAILS` | 生产必配；配置后本地自声明登录关闭，只剩 LDAP |
| `DATA_DIR` | 数据根目录（容器 `/data`） |
| `DB_FILE` / `FILES_DIR` / `MIGRATIONS_DIR` | 覆盖库文件 / 文件目录 / 迁移目录 |
| `LOGIN_MAX_FAILURES` / `LOGIN_LOCK_MINUTES` | 默认 5 次 / 15 分钟 |
| `LDAP_PAGE_SIZE` | 分页每页条目数，默认 500；`0` 关闭 |
| `LDAP_TLS_REJECT_UNAUTHORIZED` | LDAPS 严格校验证书，自签名内网 AD 保持 `false` |
| `QUARANTINE_RETENTION_DAYS` | 隔离区保留天数，默认 7 |
| `BACKUP_INTERVAL_SECONDS` / `BACKUP_KEEP` | 备份周期与数据库保留份数 |

---

## 15. 已知坑与维护守则（血泪清单）

**Node 自托管栈特有（本轮重构踩出来的，最容易复发）**：

1. **`stream.pipeline` 不接受 Web `WritableStream`**（实测 `TypeError`）。要在 Node 管道里做计数/转换，
   必须用 Node 的 `Transform`（见 `lib/storage.ts` 的 `ByteCounter`）。混合流用 `Readable.fromWeb()` 转。
2. **不要把包放进 `serverExternalPackages`**（本项目已置空）。Next 16 + Turbopack + `output:standalone`
   会给外部包在 `.next/node_modules/<pkg>-<hash>` 生成**软链**，拷进 standalone 时（Windows）退化成
   **空目录**，运行期抛 `Cannot find package '...<pkg>-<hash>/index.js'`。
   **症状极具迷惑性：构建全绿、服务能起来、一登录就 500。** 让打包器把纯 JS 依赖打进去即可。
3. **standalone 的 `server.js` 会 `process.chdir(__dirname)`，且不加载 `.env`**：
   - 数据目录必须按「应用根」而不是 cwd 解析（`lib/paths.ts anchorRoot()`），否则数据会落进 `.next/`，
     下次 `next build` 清空 `.next` 时连数据一起删掉；
   - 本地用 `node --env-file-if-exists=.env` 显式加载。已实测 `loadEnvFile` 与 `--env-file`
     **不会覆盖**已存在的真实环境变量（正是所需语义：容器注入优先）。
4. **动态路径拼接会让 Turbopack 把整个仓库 trace 进 standalone**（实测把 `_*.log`、`vendor/`、文档、
   甚至 `.env` 都拷了进去）。在这类 `path.join` 上加 `/* turbopackIgnore: true */` 注释即可。
5. **`package-lock.json` 必须与 `package.json` 同步**，否则 Docker `npm ci` 直接 `EUSAGE` 失败：
   改依赖后跑 `npm install --package-lock-only`。
6. `node:sqlite` 是 Node 的实验特性（启动会打印 `ExperimentalWarning`），属预期；用法集中在
   `db/sqlite-client.mjs` 一处，将来 API 变动只需改它。

**通用**：

7. **Edit 工具偶发"假成功"**：报成功未落盘。关键编辑后必须 grep 复核；批量修改用 node/Python 脚本精确替换。
8. **沙箱 bash 的 PATH 常不全**（`ls: command not found`）：命令前加
   `export PATH="/usr/bin:/bin:/c/Windows/System32:$PATH"`。**PowerShell 工具的 stdout 本会话不回流**，
   需要落盘再读。
9. **后台进程**：用工具自带的后台机制；`nohup … &` 在本 shim 下会被回收（日志为空、进程不存在）。
10. **新增/改写 `.ps1` 必须 UTF-8 BOM + CRLF**，否则中文与换行损坏。
11. **可见性判定只用 `lib/visibility.ts`**；**哈希只用 `lib/sha256.ts` 流式**；
    **LDAP 搜索 `returnAttributeValues` 必须为 true**。
12. 已移除功能勿复活：历史外发、`verify-archive.mjs`、交付网关（2026-09-22 用户决定整体移除）。

---

## 16. 快速上手清单（新人向）

1. 读本文 §1–§5 了解架构 → `npm install && npm run local:setup && npm run local:start`
   → 打开 `http://127.0.0.1:8787`。
2. 跑 `node scripts/mock-ldap-server.mjs --port 3890`，用账号名当口令登录联调
   （全新库里还没有 LDAP 绑定密码，回归脚本会自动写一个占位口令）。
3. 改代码：`npm run build` → 重启（或 `npm run dev` 热更）；改 schema：走 §6 流程
   （只需 `db:generate`，不再改任何清单）。
4. 提交前跑回归确认全绿：`npm run test:rekey`（不需要平台）+ 四套需要平台的
   （e2e / smoke / verify-content-type / test-ldap-login）。

---

## 17. 代码瘦身记录（2026-09-24，历史存档）

对项目做过一次可达性分析与清理，**结论：项目"体积大"99% 来自 `node_modules`，
业务源码本身只有约 12k 行、0.6 MB**，无需做架构级优化。

**已清理内容**：

| 项 | 处理 | 说明 |
|---|---|---|
| 48 个未被引用的 shadcn UI 组件（5,779 行） | 移入隔离区 | 可达性分析（从 app/views/lib 出发 BFS）确认不可达；`components/ui` 从 61 → 13 个组件 |
| 15 个无引用依赖 | 从 package.json 移除 | `@base-ui/react` `@shadcn/react` `cmdk` `date-fns` `embla-carousel-react` `input-otp` `next-themes` `react-day-picker` `react-hook-form` `react-resizable-panels` `recharts` `sonner` `vaul` `zod` `@hookform/resolvers` |
| 根目录垃圾 | 移入隔离区 | `.tmp-dev.log`、`tsconfig.tsbuildinfo`、`.next/`、`examples/`（模板残留）、`.backup/`（旧库备份） |
| `.gitignore` | 补条目并加警告注释 | **`/vendor/` 是构建必需源码（`app/globals.css` @import），切勿加入忽略** |

隔离区（**未删除，可回滚**）：本次重构中被替换掉的文件已移出仓库到本地归档目录，内含 `RESTORE.md` 恢复说明。

**清理后新增组件的正确姿势**：不要手动从隔离区拷回，用 `npx shadcn@latest add <component>`。

**体积排查方法（可复用）**：
- 死代码：从 `app/` `components/views/` `lib/` 出发做 import 可达性 BFS，`components/ui` 中不可达即为死代码
  （**不要用文本匹配**，会漏判/误判传递引用）。
- 未用依赖：先看"仅被死代码引用"（可达性分析产物），再对完全零引用的包单独核实。
- 清缓存：`node_modules/.` 下的 hash 目录可安全删除，下次构建自动重建。
