# 文件安全收发平台（transfer-approval-platform）开发维护文档

> 最后更新：2026-09-24 ｜ 适用版本：当前主干（schema marker `.transfer-platform-schema-v9`）
>
> 本文档面向后续接手开发/维护的工程师，覆盖架构、目录、环境搭建、核心模块、测试与已知坑。部署细节另见 `LOCAL-DEPLOYMENT.md`（本地）、`DOCKER-DEPLOYMENT.md`（容器，§9.5 为首次构建实录）、`PROD-DEPLOYMENT.md`（生产）、`CONTENT-TYPE-GUARD.md`（内容防护专项）。

---

## 1. 项目定位与总体架构

局域网内使用的**文件安全收发与审批平台**，单平台单库单 R2，**不出网**（原"交付网关/历史外发"功能已于 2026-09-22 整体移除，`DELIVERY_*`/`GATEWAY_*` 变量作废，`verify-archive.mjs` 已删）。

```
浏览器 (React SPA, App Router)
   │  fetch /api/*
   ▼
Cloudflare Worker（vinext 构建产物 dist/，wrangler dev / 容器内 wrangler 启动）
   ├── D1 (SQLite)：业务数据 + 审计链
   ├── R2：文件对象（按 objectKey 存取）
   ├── Integration Settings（D1 表，加密存储）：LDAP 认证源配置
   └── LDAP（可选）：域账号认证 + 目录同步
```

核心闭环：**提交文件 → 规则引擎判定 → 自动通过即送达 / 待审批 → 审批通过后送达 → 收件人下载（逐人记录 download_deliveries）→ 全程审计（哈希链）**。

---

## 2. 技术栈

| 层 | 技术 | 版本 |
|---|---|---|
| 框架 | Next.js（App Router, RSC）via **vinext** | next 16.3.4 / vinext 1.0.0-beta.5 |
| 运行时 | Cloudflare Workers（wrangler dev，workerd） | wrangler 4.92.0 |
| 构建 | Vite + @cloudflare/vite-plugin | vite 8 |
| ORM | Drizzle ORM + drizzle-kit | 0.45.2 / 0.31.10 |
| UI | Tailwind CSS 4 + radix-ui + lucide-react + cva/clsx/tailwind-merge | — |
| Node | ≥ 22.13 | — |

**关键约束**：
- **禁止运行时重建 dist**——dist 是构建期产物，改代码必须重新 build 再重启。
- 生产禁用 `vinext start`（无 D1/R2 绑定），必须用 wrangler 加载 `dist/server/wrangler.json` 启动。
- 停本地 dev 用 `scripts/stop-dev-server.ps1`（需管理员权限）。

---

## 3. 目录结构

```
app/                      # Next.js App Router
├── page.tsx              # 主页面（SPA 视图切换 + mapApplication 数据映射）
├── login/                # 登录页
└── api/                  # 全部 REST API（见 §7）
components/
├── ui/                   # 基础组件（shadcn 风格）
│                         # 2026-09-24 已瘦身：仅保留 13 个被实际引用的组件
│                         # badge, button, dialog, input, label, select, separator,
│                         # sheet, sidebar, skeleton, table, textarea, tooltip
│                         # 需要新组件时用 `npx shadcn@latest add <name>` 重新引入
└── views/                # 业务视图
    ├── Dashboard.tsx / SubmitView.tsx / ApplicationsView.tsx
    ├── ApplicationTable.tsx    # 发送记录表（无"命中规则"列，判定原因在状态徽章下小字）
    ├── ApprovalsView.tsx       # 审批（本人提交的单隐藏按钮，管理员可自批）
    ├── InboxView.tsx / AuditView.tsx / RulesView.tsx
    ├── LdapView.tsx / NavGroup.tsx / shared.tsx  # shared.tsx 含 Application 类型与 mapApplication
lib/                      # 核心业务库（见 §5）
db/                       # schema.ts（Drizzle 表定义）、index.ts（连接）
drizzle/                  # 迁移 SQL：0000-0003, 0005-0009（无 0004，已跳号）+ meta/
scripts/                  # 部署/测试/工具脚本（见 §9）
docker/                   # Dockerfile.platform、entrypoint-platform.sh、init-db.mjs、
                          # prepare-runtime-config.mjs、ldap/Dockerfile.ldap + seed.ldif
docker-compose.yml        # platform + ldap（--profile dev）
```

---

## 4. 本地开发环境（Windows）

```powershell
npm install                 # 或 npm run install:ci
npm run local:setup         # 首次：生成 local.config.json、初始化 D1/R2 状态目录
npm run local:start         # 启动，端口 8787
npm run dev                 # vite dev（改代码热更，但绑定/迁移仍需 local:setup）
npm run build               # 产 dist（node scripts/run-framework.mjs build）
npm run local:reset         # 重置演示数据
```

- **状态目录**：真实 `%TEMP%\transfer-platform-state`（不是 bash 的 `/tmp`）。
- **⚠️ bash 起 wrangler 的坑**：bash 的 `$TEMP=/tmp` ≠ 真实 `%TEMP%`。若在 Git Bash 里手工起 wrangler，必须显式 `--persist-to C:/Users/<user>/AppData/Local/Temp/transfer-platform-state`，否则是空库（表现为 config 接口 500、登录 422）。
- 新增 `.ps1` 脚本必须 **UTF-8 BOM + CRLF**，否则中文/换行损坏。

---

## 5. 核心模块（lib/）

| 文件 | 职责 | 注意事项 |
|---|---|---|
| `server.ts` | 服务端主逻辑：会话、规则引擎 `evaluateFileDetailed()`、提交/审批/送达 pipeline | preview 与提交共用同一引擎，勿复制逻辑 |
| `visibility.ts` | **唯一**可见性判定入口 | 任何"我能看到哪些单"的查询都必须走它，不得另写过滤 |
| `file-type.ts` | 文件首 512B 魔数嗅探（纯函数，无 IO） | |
| `content-guard.ts` | 内容类型防伪装策略层（见 §8） | |
| `sha256.ts` | 流式哈希 | **禁用 `arrayBuffer()`**（大文件爆内存），必须流式 |
| `session.ts` / `login-guard.ts` | 会话与登录失败锁定 | 锁定记录在 `login_attempts` 表（非内存），锁定返回 429。勿用「lockedUntil 空 ⇒ 已过期」判断（踩过坑） |
| `ldap-client.ts` | 原生 BER 编码的 LDAP 客户端（`cloudflare:sockets`） | **搜索请求 typesOnly 必须为 0x00 (FALSE)**。曾误写 0xff：openldap 只回属性名、值全空（抓包特征 `31 00`），导致同步出"DN 当邮箱"的坏用户；mock LDAP 忽略该标志所以本地从未暴露 |
| `ldap-config.ts` / `ldap-user.ts` | 认证源配置（D1 加密存储）、目录用户 | |

---

## 6. 数据模型（db/schema.ts，D1）

11 张表：

| 表 | 用途 |
|---|---|
| `applications` | 发送单。含内容防护字段 `detected_kind` / `detected_extensions` / `type_mismatch` / `content_signature`（0009 引入，同时删了旧 `kind` 列与归档数据） |
| `rules` | 审批规则（见 §10） |
| `application_recipients` | 站内收件人（0007 起替代旧 recipients 外发表，收件人来自 LDAP 域账号） |
| `audit_events` | 审计链（previous_hash/hash 哈希链，防篡改） |
| `download_deliveries` | 逐收件人送达记录；`first_downloaded_at` 即"已读"凭据（**不建已读表**） |
| `download_events` | 下载事件流水 |
| `ldap_users` / `ldap_sync_runs` | LDAP 目录快照与同步记录 |
| `login_attempts` | 登录失败锁定 |
| `integration_settings` | 集成配置（LDAP 认证源、contentTypeGuard 开关等，加密存储） |
| `role_assignments` | 角色分配（管理员/审批人/审计员） |

**迁移规范**：
- marker：`.transfer-platform-schema-v9`；全集 `0000-0003, 0005-0009`（无 0004）。
- 新增迁移流程：改 `db/schema.ts` → `npm run db:generate` → 把新 SQL 加进 `scripts/local-setup.ps1` 与 `docker/entrypoint-platform.sh`（或 `docker/init-db.mjs`）的 `--files` 列表，并**同步升 marker**。两处必须同步维护。

---

## 7. API 一览

```
POST /api/auth/login | /api/auth/logout        GET /api/auth/me
GET  /api/bootstrap                            # 首屏聚合：可见单 + recipients/deliveries（inArray 过滤），
                                               # 并补超窗口的「发给我」单据
POST /api/applications?fileName=&recipients=   # body=文件字节流；规则引擎→自动通过即送达/待审批
GET  /api/applications
POST /api/applications/[id]/decision           # 审批通过/驳回；发起人回避校验（管理员豁免，见 §9）
POST /api/applications/[id]/revoke             # 撤回：本人 + 管理员/审批人（勿用 requireApprover，否则发起人 403）
POST /api/applications/[id]/transfer           # 转办
GET  /api/files/[id]                           # 下载（鉴权见 §11）
GET/PUT /api/admin/config                      # PUT 认证源字段名是 secret（LDAP bind 密码）
GET/POST /api/admin/roles                      # 角色分配
GET/POST /api/rules ; GET/PUT/DELETE /api/rules/[id] ; POST /api/rules/preview
POST /api/ldap/sync ; POST /api/ldap/test-bind
GET  /api/audit/export                         # 审计导出
POST /api/admin/cleanup                        # 清理
```

---

## 8. 认证与角色

**登录契约**（`lib/login-guard.ts` + `ldap-client.ts`）：
1. LDAP 模式：服务帐号（bindDn `cn=admin,dc=example,dc=local`）搜索用户 DN → 用户 DN + 密码重 bind。
2. 搜不到且输入不像 DN ⇒ 直接失败（防枚举）。
3. 密码**不落库、不进审计**。
4. 本地兜底 `{local:true}`：仅在未配置 `PLATFORM_ADMIN_EMAILS` 时可用；自声明用户仅联调态。
5. 失败锁定：`LOGIN_MAX_FAILURES`(默认5) 次 / `LOCK_MINUTES`(15)，记录在库内（workerd 重启内存清零但表里有）；锁定返回 429。

**角色**：管理员（`PLATFORM_ADMIN_EMAILS`，生产必配——配了之后只剩 LDAP 登录）、审批人、审计员，存 `role_assignments`，管理页可配。

**审批回避（职责分离）**：`decision` 接口校验——`角色≠管理员` 且 `requesterEmail==actor.email` → 403「不能审批自己提交的发送单」。**管理员权限完全放开，可自批**。提交时 `assignedApprovers` 剔除发起人（剔除后为空回退管理员）；前端 `ApprovalsView` 对本人单显示"本人提交，需他人审批"徽章（管理员显示"本人提交"但按钮可用）。

---

## 9. 收发闭环与关键流程

1. **提交** `POST /api/applications?fileName=&recipients=`（body 为文件字节）：
   - 魔数嗅探（file-type.ts）→ 内容防护判定（content-guard.ts，见 §10）
   - 规则引擎判定：自动通过 → 直接进送达 pipeline；否则 `status=待审批`，`assignedApprovers` 已剔除发起人
   - 落库 `detected_kind/detected_extensions/type_mismatch/content_signature`
2. **审批**：通过后走与自动通过相同的 pipeline，逐收件人写 `download_deliveries`。
3. **下载** `files/[id]` 鉴权顺序：
   - 本人 / 管理员 / 审计员 / 被指派审批人 → 放行
   - 收件人 → 须满足：单据 `TRANSFERRED` + 该收件人送达 enabled + 未撤回；否则返回明确原因 `NOT_DELIVERED` / `DELIVERY_REVOKED` / `FORBIDDEN`
4. **撤回**：本人 + 管理员/审批人。
5. **收件箱角标**：走 NavGroup badges；"已读"以 `first_downloaded_at` 为凭据，无已读表。
6. **workerd 坑**：对上传中的请求体 `cancel()` 会让 worker 瞬断（下一请求 503）。`failWithStream` 已改为 `pipeTo` 读完再回错，**勿改回 cancel**。

---

## 10. 内容类型防伪装（CONTENT-TYPE-GUARD.md）

**定稿语义（勿改动）**：
- 声明后缀 ≠ 内容魔数 → **403 拒绝**
- 未知类型：`normal` 档转人工审批 / `strict` 档拒绝 / `off` 仅记录
- 开关在**管理页 `contentTypeGuard`**（integration_settings 表，guardOnly 局部更新），**不是环境变量**

能力边界：只防"改后缀不改内容"，转码/截图类伪装防不了。

---

## 11. 规则引擎

字段：`extensions` / `minSize` / `maxSize`（字节，UI 展示用 MB）/ `action` / `scope` / `approverEmails` / `priority`（数字小者先匹配）。

**常见误配**：「最小 1MB」写反方向会让所有小文件落入 R-FALLBACK 转人工。判定逻辑唯一入口 `lib/server.ts evaluateFileDetailed()`，规则预览（`/api/rules/preview`）与提交共用。

---

## 12. 测试与回归脚本（scripts/）

> 全部是**真实写入**的回归，只允许打开发/验收环境，禁止对生产执行。

| 脚本 | 内容 | 备注 |
|---|---|---|
| `e2e-internal-transfer.mjs` | 29 项收发闭环 | `--mock-ldap` 自动切/还原配置；默认不同步目录 |
| `smoke-test.mjs` | 26 项冒烟 | 需 `--write` + 三角色账号口令 |
| `verify-content-type.mjs` | 26 项内容防护 | 收件人可用 `E2E_RECIPIENT_EMAIL` 环境变量回退；非 mock 分支先登录收件人 |
| `test-ldap-login.mjs` | 14 项 LDAP 登录 | **zhaoliu 会触发锁定 15 分钟**，别频繁跑 |
| `check-sha256.mjs` | 下载哈希一致性 | |
| `mock-ldap-server.mjs` | 本地 mock LDAP | `node scripts/mock-ldap-server.mjs --port 3890`，口令=账号名 |

**测试账号与口令（两套，勿混用）**：
- 容器 `--profile dev` 的 openldap（389 端口，seed.ldif）：口令 `Passw0rd!<账号名>`
- 本地 mock（3890）：口令 = 账号名
- 账号：`zhangsan`(管理员) / `wangwu`(审批人) / `lisi`、`zhaoliu`(发起人)

容器回归基线（2026-09-23 实测）：e2e 25/25（无 mock 切源 4 项）+ smoke 26/26 + content-type 21/21。

---

## 13. Docker 部署要点（详见 DOCKER-DEPLOYMENT.md）

```bash
cp .env.docker.example .env       # CONFIG_ENCRYPTION_KEY 随机 32 字节 hex（备份勿提交）
npm run docker:build && npm run docker:up:dev    # dev profile 才含 LDAP 容器
npm run docker:smoke
```

单镜像，D1/R2 落 `/data/state`；entrypoint 跑迁移（marker 同本地）。**首次构建四个坑（§9.5 有全记录）**：

1. `npm run install:ci` 依赖 scripts/ → Dockerfile 构建阶段须在 `COPY . .` 之前 `COPY scripts`。
2. `NODE_ENV=production` 下 npm 隐式 omit dev → 运行阶段装 wrangler 必须 `npm install --include=dev wrangler@...`。
3. seed.ldif **不要单文件挂载**（osixia 引导会 `sed -i` 改写导致 rename 失败、容器崩溃）→ 已打进自定义镜像 `docker/ldap/Dockerfile.ldap`。
4. **LDAP 种子只在空卷首启导入**：改种子后需 `docker compose rm -sf ldap` + 删 `ldap-data`/`ldap-config` 两卷（**勿 `down -v`**，会连 platform 数据一起删）+ `--build` 重建。

容器内配置链路（首启手工配一次）：先用兜底 `local:true` 登录 → PUT `/api/admin/config` 指向 `ldap:389`（字段名 `secret`）→ POST `/api/ldap/sync` → 管理页配角色。

---

## 14. 生产部署关键变量

| 变量 | 说明 |
|---|---|
| `CONFIG_ENCRYPTION_KEY` | integration_settings 加密密钥，**不可轮换**（换了旧配置全解不开） |
| `PLATFORM_ADMIN_EMAILS` | 生产必配；配置后本地自声明登录关闭，只剩 LDAP |
| `LOGIN_MAX_FAILURES` / `LOCK_MINUTES` | 默认 5 次 / 15 分钟 |

---

## 15. 已知坑与维护守则（血泪清单）

1. **Edit 工具偶发"假成功"**：报成功未落盘。关键编辑后必须 grep 复核；批量修改用 node/Python 脚本做精确替换。
2. **禁止运行时重建 dist**；停本地服务用 `scripts/stop-dev-server.ps1`（管理员）。
3. **bash `$TEMP` ≠ 真实 `%TEMP%`**（见 §4）。
4. **workerd cancel 请求体 → worker 瞬断**（见 §9.6）。
5. **沙箱 bash PATH 不全**：优先用内置工具；node 直接调 `scripts/run-framework.mjs`。
6. **`prepare-local-config.mjs` 仍写 `deliveryGateway*` 惰性键**：无消费者，未清理，知悉即可。
7. **可见性判定只用 `lib/visibility.ts`**；**哈希只用 `lib/sha256.ts` 流式**；**LDAP typesOnly 必须 0x00**。
8. 已移除功能勿复活：历史外发、`verify-archive.mjs`、交付网关（2026-09-22 用户决定整体移除）。

---

## 16. 快速上手清单（新人向）

1. 读本文 §1–§5 了解架构 → `npm install && npm run local:setup && npm run local:start` → 打开 `http://127.0.0.1:8787`。
2. 跑 `node scripts/mock-ldap-server.mjs --port 3890`，用账号名当口令登录联调。
3. 改代码：`npm run build` → 重启（或 dev 模式热更）；改 schema：走 §6 迁移流程，同步两处 --files。
4. 提交前跑三套回归（e2e / smoke / verify-content-type）确认全绿。

---

## 17. 代码瘦身记录（2026-09-24）

对项目做过一次可达性分析与清理，**结论：项目"体积大"99% 来自 `node_modules`（约 768 MB），业务源码本身只有约 12k 行、0.6 MB**，无需做架构级优化。

**已清理内容**：

| 项 | 处理 | 说明 |
|---|---|---|
| 48 个未被引用的 shadcn UI 组件（5,779 行） | 移入隔离区 | 可达性分析（从 app/views/lib 出发 BFS）确认不可达；`components/ui` 从 61 → 13 个组件 |
| 15 个无引用依赖 | 从 package.json 移除 | `@base-ui/react` `@shadcn/react` `cmdk` `date-fns` `embla-carousel-react` `input-otp` `next-themes` `react-day-picker` `react-hook-form` `react-resizable-panels` `recharts` `sonner` `vaul` `zod` `@hookform/resolvers` |
| 根目录垃圾 | 移入隔离区 | `.tmp-dev.log`、`tsconfig.tsbuildinfo`、`.next/`、`examples/`（模板残留）、`.backup/`（旧库备份） |
| `.gitignore` | 补条目并加警告注释 | **特别注意：`/build/`、`/vendor/`、`/.openai/` 是构建必需源码，切勿加入忽略** |

隔离区（**未删除，可回滚**）：`D:\AI\workBuddy\_cleanup-quarantine\transfer-platform-20260924\`，内含 `RESTORE.md` 恢复说明。

**清理后新增组件的正确姿势**：不要手动从隔离区拷回，用 `npx shadcn@latest add <component>`（会自动带回其依赖，如需要 recharts / react-hook-form 等）。

**实测效果**：`package.json` 依赖 21 → 9 项；业务源码行数约 12,100 → 6,300；`node_modules` 768.5 MB → 742.3 MB（全项目约 745 MB）。构建验证 `npm run build` 通过，19 条路由全部正常。
> 注：磁盘节省有限，是因为被删依赖只占约 26 MB——**大部分体积是 next / @cloudflare / @next / wrangler / typescript 等工具链本体，属于栈固有成本，不换栈省不下来**。

**⚠️ 本机 npm 必须加 `--offline`**：该环境走代理访问 registry 会长时间无响应（实测 `npm uninstall` 卡死 12 分钟）。所有 npm 变更操作请用：
```powershell
npm uninstall <pkg> --offline --no-audit --no-fund
npm prune --offline --no-audit --no-fund
```
另注意：npm 删除包后会残留在 `node_modules/.<包名>-<hash>` 形式的编译缓存目录（本次实测残留约 22 MB），需手工清理 `node_modules` 下 `.` 开头且非 `.bin` 的目录。

**体积排查方法（可复用）**：
- 死代码：从 `app/` `components/views/` `lib/` 出发做 import 可达性 BFS，`components/ui` 中不可达即为死代码（**不要用文本匹配**，会漏判/误判传递引用）。
- 未用依赖：先看"仅被死代码引用"（可达性分析产物），再对完全零引用的包单独核实。
- 清缓存：`node_modules/.` 下的 hash 目录可安全删除，下次构建自动重建。
