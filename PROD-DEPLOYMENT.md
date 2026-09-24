---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 272606a132a8da52fe9ed93c68e6156a_1759497eb3de11f185dc525400de85a5
    ReservedCode1: lKOHBRWUZVtDQRosuvTurOcs1mQRWX3/UxT8e/0tEOiMlkrCtPssl7TRZaCi0kNSB2Xp8z0w+M1xQe2cwlj0R/ahKdeek0b4ONypCHWPeHA07Ykjtw7oBq2s2J/kT/McpB9k1j5QmMVe8FIRpNB+Vpj31nNFO92NcVJXY4uTkvz1Pw2lCCm/kTfIVdc=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 272606a132a8da52fe9ed93c68e6156a_1759497eb3de11f185dc525400de85a5
    ReservedCode2: lKOHBRWUZVtDQRosuvTurOcs1mQRWX3/UxT8e/0tEOiMlkrCtPssl7TRZaCi0kNSB2Xp8z0w+M1xQe2cwlj0R/ahKdeek0b4ONypCHWPeHA07Ykjtw7oBq2s2J/kT/McpB9k1j5QmMVe8FIRpNB+Vpj31nNFO92NcVJXY4uTkvz1Pw2lCCm/kTfIVdc=
---

# 正式环境部署手册

> 配套文档：容器化细节见 `DOCKER-DEPLOYMENT.md`，本地联调见 `LOCAL-DEPLOYMENT.md`。
> 本手册描述**单平台、单库、单 R2、纯局域网**形态的正式环境部署、初始化、验收与回滚。
>
> ⚠️ 需求变更（2026-09-21 定稿，评估见 `UNIFIED-TRANSFER-EVAL.md` §8）：收发的收发双方都是局域网内的域账号用户，
> 平台不出网。**原「内网审批区 + DMZ 交付网关 + 匿名外链下载」的双服务形态已整体下线**，
> 旧版本文档中的 `DELIVERY_*` 变量、网关部署章节、跨段防火墙策略均已作废。
>
> ⚠️ 交付形态以容器为准。D1/R2 在容器部署下对应**持久卷内的 SQLite 文件与目录**，不需要 Cloudflare 云资源；
> 卷结构见 `DOCKER-DEPLOYMENT.md` §4，启动命令见 §4.2。

## 1. 部署拓扑

```
        ┌────────────── 局域网（审批区） ──────────────┐
        │  文件安全收发平台（Worker 运行时 / workerd）  │
        │   ├─ D1 业务库（发送单/收件人/规则/角色/      │
        │   │            送达记录/审计哈希链）          │
        │   ├─ R2 隔离区桶（待审文件 + 已送达文件）     │
        │   └─ 直连 AD/LDAP（389 / 636：同步 + 登录）   │
        │                                              │
        │ 浏览器访问：https://transfer.<内网域名>       │
        └──────────────────────────────────────────────┘
                 ▲                          ▲
                 │ 办公网段（发送人/审批人/审计员）
                 │                          │ 域账号用户（收件人）
                 └──────────────────────────┘
```

- **单服务**：一个镜像、一个容器、一个持久卷。
- **不出网**：平台不调用任何外部服务，也没有对外的下载链接或交付网关。
- **收件人就是域账号用户**：审批通过后文件"送达"到收件人的站内**收件箱**，登录后下载（会话鉴权，每次留痕）。

防火墙策略（最小放行）：

| 源 | 目标 | 端口 | 用途 |
|---|---|---|---|
| 办公网段 | 平台 | 443 | 用户访问（前置 HTTPS 反向代理） |
| 平台 | AD/LDAP | 389 或 636 | 目录同步 + **域账号登录 bind** |

**禁止**：平台端口对公网暴露（本形态无公网使用场景）。

## 2. 资源与依赖清单

| 资源 | 要求 | 说明 |
|---|---|---|
| 运行时 | 容器：Linux 基础镜像 + workerd（由 `wrangler dev --local` 拉起 `dist`） | ⚠️ **不是** `vinext start`：Node 服务器不注入 D1/R2 绑定，用它跑会直接失败 |
| 数据库 | D1（容器内落地为持久卷上的 SQLite 文件） | 单一业务库，含发送单、收件人、送达记录、审计 |
| 对象存储 | R2（隔离区桶 `BUCKET`，容器内落地为持久卷上的目录） | 待审文件与已送达文件；拒收文件到期清理 |
| 证书 | 内网 HTTPS 证书 | 容器只提供 HTTP，HTTPS 由前置反向代理终结 |
| 容器引擎 | Docker / Podman（含 compose v2） | 单宿主机即可 |
| 目录服务 | 内网 AD / LDAP | 平台需能直连 389/636；登录走 simple bind |

## 3. 环境变量矩阵

生产必填项加粗：

| 变量 | 必填 | 说明 |
|---|---|---|
| **`CONFIG_ENCRYPTION_KEY`** | 是 | 会话签名 + LDAP 密码加密。**上线后不可更换**，否则所有会话失效、已存 LDAP 密码无法解密。生成后离线备份（如密码保险柜） |
| **`PLATFORM_ADMIN_EMAILS`** | 是 | 管理员邮箱名单（逗号分隔）。**配置后「本地管理员」兜底登录与自声明登录同时禁用** —— 生产不配等于任何人都能冒用任意身份 |
| `PLATFORM_APPROVER_EMAILS` | 建议 | 审批人邮箱名单；与「角色管理」页双轨生效 |
| `PLATFORM_AUDITOR_EMAILS` | 建议 | 审计员邮箱名单 |
| `ALLOW_SELF_DECLARED_LOGIN` | 否 | 保持 `false`（默认）。仅在无 LDAP 的联调环境才设 `true` |
| `LOGIN_MAX_FAILURES` | 否 | 连续登录失败多少次锁定，默认 5 |
| `LOGIN_LOCK_MINUTES` | 否 | 锁定时长（分钟），默认 15 |
| `QUARANTINE_RETENTION_DAYS` | 否 | 隔离区文件保留天数，默认 7 |
| `PLATFORM_BIND` | 否 | 宿主机绑定地址，默认 `127.0.0.1`；正式部署改为审批网段地址 |

**已作废的变量**（旧网关方案，代码里已无消费方，不要配）：

`DELIVERY_GATEWAY_ENDPOINT`、`DELIVERY_GATEWAY_TOKEN`、`DELIVERY_PUBLIC_BASE_URL`、
`DELIVERY_DEFAULT_EXPIRY_HOURS`、`DELIVERY_DEFAULT_MAX_DOWNLOADS`、`GATEWAY_BEARER_TOKEN`、
`DOWNLOAD_BASE_URL`。

> `local.config.json` 与 `local.config.example.json` 仅用于本地联调，**不得**带入生产；
> 生产变量通过部署平台的变量/密钥机制注入。

## 4. 部署步骤

### 4.1 数据库初始化

**容器部署下不需要手工执行迁移** —— 容器启动时由 `docker/init-db.mjs` 幂等应用，
标记文件 `.transfer-platform-schema-v8`（平台侧唯一标记）。

仅当不用容器、手工部署时才需要（**注意没有 `0004`**，按文件名编号顺序执行，禁止跳过）：

```bash
node docker/init-db.mjs --config dist/server/wrangler.local.json --db site-creator-d1 \
  --persist-to <持久化目录> --marker <持久化目录>/.transfer-platform-schema-v8 \
  --files drizzle/0000_noisy_human_cannonball.sql,drizzle/0001_cloudy_raider.sql,drizzle/0002_transfer_platform_enhance.sql,drizzle/0003_delivery_gateway.sql,drizzle/0005_ldap_direct.sql,drizzle/0006_ldap_filter.sql,drizzle/0007_unified_transfer.sql,drizzle/0008_ldap_login.sql
```

各迁移的作用（便于核对）：

| 迁移 | 内容 |
|---|---|
| 0000–0002 | 平台基础表：申请、规则、角色、审计哈希链、LDAP 目录 |
| 0003 | 交付网关时期的两张表（`download_deliveries` / `download_events`，0007 已重建为站内语义） |
| 0005 / 0006 | LDAP 直连配置与过滤器 |
| **0007** | 单平台改造：`applications.kind`（存量标记为 `legacy_external`）、`application_recipients`（站内收件人）、`download_deliveries` 重建（去掉外链字段）、删除 `recipients` 表 |
| **0008** | 域账号登录：`ldap_users.account`（sAMAccountName 映射）+ `login_attempts`（落库的失败计数） |

### 4.2 构建与启动平台

```bash
cp .env.docker.example .env        # 必填 CONFIG_ENCRYPTION_KEY；生产必须同时填 PLATFORM_ADMIN_EMAILS
docker compose up -d --build platform
```

等价的手工启动命令（容器入口脚本内部就是这几步）：

```bash
npm ci
npm run build          # 产物在 dist/（会清空 dist，必须先停服）
node docker/prepare-runtime-config.mjs --role platform   # 生成 dist/server/wrangler.local.json 并注入环境变量
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js dev \
  --config dist/server/wrangler.local.json --local --persist-to /data/state --ip 0.0.0.0 --port 8787 --inspector-port 0
```

❌ **不要用 `npx vinext start`。** 它启动 Node 生产服务器，不提供任何 D1/R2 绑定逻辑，
文件存储与数据库访问会在运行期失败。详见 `DOCKER-DEPLOYMENT.md` §1。

启动前确认绑定：`DB`（业务库，持久卷上的 SQLite）、`BUCKET`（隔离区，持久卷上的目录）。

### 4.3 身份接入与登录门槛 ⚠️

平台按优先级取身份：

1. **前置 SSO / 反向代理注入 `oai-authenticated-user-email` 请求头**（可选）：存在该头时平台直接采信，
   `/login` 页面与域账号登录自动停用。适合已有统一认证网关的部署。
2. **域账号 + 域密码（本方案的默认路径）**：登录页收账号（`zhangsan`）或邮箱 + 密码，
   平台用服务帐号在目录中定位用户 DN，再用「用户 DN + 域密码」重新建连 bind 校验。
   密码只在内存中使用，**不落库、不进审计**。
3. **本地兜底 / 自声明登录**：仅当未配置 `PLATFORM_ADMIN_EMAILS` 时可用，**生产严禁**。

上线门槛（满足其一）：

- 配置 `PLATFORM_ADMIN_EMAILS`（此时兜底与自声明自动关闭，只剩域账号登录），或
- 接入 SSO 头透传（并同样配置角色名单）。

失败锁定：连续失败 `LOGIN_MAX_FAILURES` 次锁定 `LOGIN_LOCK_MINUTES` 分钟（返回 429），成功即清零。
计数器落在表 `login_attempts`（**落库而非内存**，避免 workerd 实例重建后失效）。

### 4.4 LDAP / AD 配置

在「LDAP 与权限」页填写：名称、主机、端口、是否 LDAPS、服务帐号（建议 UPN 形式 `svc@domain.local`）、
密码、Base DN、搜索过滤器（默认 `(objectClass=person)`）。

- 平台需能直连 AD 的 389/636 端口；网络不通时绑定会报 `resultCode 49`
  （凭据类错误码会被解析为具体子码，如 `52e` 密码错误）
- 服务帐号密码以 `CONFIG_ENCRYPTION_KEY` 加密后落库，界面回显为空表示已保存
- **上线前用页面的「认证自检」卡片验证 bind 链路**：它跑的是与登录完全相同的代码路径，
  但**不建立会话、不计入失败计数**，可以放心用于排查
- 同步只依赖用户名与组（`memberOf` → 部门）；`sAMAccountName` 会写入 `ldap_users.account`，
  因此「短名登录」与「邮箱登录」能定位到同一个人
- ⚠️ 收件人必须是 LDAP 目录中 `active` 的记录，且**建议邮箱形式**；
  若同步来的账号是纯 DN（不含 `@`），它不能作为收件人

### 4.5 内容类型防护（上传防伪装）

上传时会读取文件首部 512 字节做**魔数嗅探**，与声明后缀比对：

- **不一致 → 直接拒绝**（403「文件格式不正确…请勿通过修改文件后缀绕过审批」）；
- **未知类型**（无签名、非文本）→ normal 档转人工审批 / strict 档拒绝；
- **off 档**只记录嗅探结果不影响判定（排查误伤时临时使用）。

档位在管理端「规则管理 → 内容类型防护」切换（`integration_settings.contentTypeGuard`），改动写审计台账。
上线前建议按 §6 用 `verify-content-type.mjs` 全量验收。

> 旧版「存量外发归档」流程已随**历史外发功能整体移除**（迁移 0009 同时清理了归档数据与 `kind` 列），
> 不再需要 §4.5 的归档终止操作。

## 5. 业务初始化清单

1. **角色**：配置管理员 / 审批人 / 审计员名单（`PLATFORM_*_EMAILS` 或角色管理页）
2. **目录**：配置并执行一次 LDAP 同步，核对人数与部门映射；确认常用收件人都是 `active` 且有邮箱
3. **审批规则**：按优先级录入，注意两个口径——
   - 「最小大小」= **下限**（填 1MB 表示 ≥1MB 才命中；小文件会落到兜底规则）
   - 「最大大小」= **上限**（留空表示不限）
   - 扩展名填写不带点，如 `bin,docx,xlsx,pptx`
   - 兜底规则 `R-FALLBACK` 对未命中文件转人工审批
4. **隔离区保留策略**：确认 `QUARANTINE_RETENTION_DAYS` 与合规要求一致
5. **内容类型防护**：确认档位（默认 normal），必要时先 off 观察一段再收紧

## 6. 上线验收清单

**容器与编排**

- [ ] 镜像构建成功，`docker compose ps` 显示 `healthy`
- [ ] 容器重启后会话仍有效、业务数据不丢（验证 `CONFIG_ENCRYPTION_KEY` 与数据都落在卷里）

**脚本自动验收**（用法见 `DOCKER-DEPLOYMENT.md` §8.1）

- [ ] `node scripts/check-sha256.mjs` 通过
- [ ] `node scripts/test-ldap-login.mjs --base <平台> --ldap-port 389` 全部通过（真实 AD）
- [ ] `node scripts/smoke-test.mjs --base <平台> --admin <账号> --approver <账号> --requester <账号> --write` 全部通过
- [ ] `node scripts/e2e-internal-transfer.mjs --base <平台>` 全部通过
- [ ] `node scripts/verify-content-type.mjs --base <平台>` 全部通过

**业务与权限**

- [ ] 未登录访问平台跳转登录页，接口返回 401
- [ ] 域账号 + 域密码登录成功；密码错误被拒且失败计数递增；连续失败触发 429 锁定
- [ ] 配置 `PLATFORM_ADMIN_EMAILS` 后，兜底登录与自声明登录均不可用
- [ ] 管理员/审批人/审计员/发起人四种角色登录后菜单与可见范围正确
- [ ] 提交文件 → 规则判定（预判与最终结果一致）→ 审批 → 收件人收件箱出现「未读」
- [ ] 收件人下载成功，内容 SHA-256 与源文件一致，收件箱转为「已下载」，审计有下载事件
- [ ] 审批通过前收件人下载被拒（403）；撤回后立即无法下载，送达记录 `enabled=0`
- [ ] 发送方可随时撤回自己的发送单；审计台账哈希链「连续无异常」，CSV 可导出
- [ ] 内容类型防护：改后缀提交被拒（403 格式不正确）、未知类型转人工、三档切换生效
- [ ] LDAP 同步写入人数与 AD 实际一致（对比组/部门抽样）
- [ ] 大文件（≥100MB）提交、审批与收件人下载成功（验证流式处理链路）
- [ ] 回滚演练：切回上一版本镜像标签，平台可正常登录与读数据

## 7. 运维约定

- **改代码流程（容器）**：`IMAGE_TAG=<新标签> docker compose build && docker compose up -d platform`。
  数据库迁移在容器启动时自动应用，无需手工介入
- **改代码流程（不装容器）**：停服 → `npm run build` → 启动。
  ⚠️ 运行中重建 `dist` 会打断正在运行的实例
- **定期回归**（建议每次升级后）：
  - `node scripts/smoke-test.mjs --base <地址> --admin <账号> --approver <账号> --requester <账号>`
  - `node scripts/e2e-internal-transfer.mjs --base <地址>`
  - `node scripts/verify-content-type.mjs --base <地址>`
- **哈希自检**：`node scripts/check-sha256.mjs`
- **审计归档**：定期导出审计 CSV 并异地保存，保留策略默认永久
- **密钥轮换**：`CONFIG_ENCRYPTION_KEY` **不可轮换**（唯一需要离线保管的密钥）
- **卷备份**：`docker run --rm -v <项目名>_platform-data:/data -v $PWD:/backup alpine tar czf /backup/platform-data.tgz -C /data .`
  （备份含加密密钥，需按密钥等级保管）

## 8. 回滚预案

| 场景 | 处置 |
|---|---|
| 新版本功能异常（容器） | `IMAGE_TAG=<上一版本> docker compose up -d platform`。数据在卷里不受影响，迁移只增不删列，可安全回滚 |
| 新版本功能异常（非容器） | 切回上一版本 `dist` 产物并重启 |
| 变量配置错误导致无法登录 | 恢复上一份变量快照；`CONFIG_ENCRYPTION_KEY` 必须与上线时一致，否则会话与已存 LDAP 密码全部失效 |
| 登录全部失败（LDAP 侧故障） | 用「认证自检」定位是网络/凭据还是过滤条件；应急可临时放开 `PLATFORM_ADMIN_EMAILS` 之外的兜底（仅限受控窗口），事后立即恢复 |
| 内容防护误伤正常业务 | 管理页临时切 `off`（只记录不拦截）恢复收发，定位后修正规则或回到 normal |
| 数据损坏 | 使用卷备份快照恢复；隔离区文件与发送单通过 `objectKey` 对应 |

*（内容由AI生成，仅供参考）*
