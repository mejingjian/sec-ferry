# 容器化部署手册

> 配套文档：部署拓扑与环境变量矩阵见 `PROD-DEPLOYMENT.md`；不装 Docker 的调试方式见 `LOCAL-DEPLOYMENT.md`；
> 架构与实现细节见 `DEVELOPMENT.md`。
>
> **2026-09-24 起运行时已改为标准 Node**（Next standalone 的 `node server.js`），
> 本手册已同步重写。旧版（workerd + `wrangler dev` + 运行阶段装 wrangler + 启动时生成
> `wrangler.local.json`）的内容已作废 —— 相关脚本与镜像配置已移入隔离区。

## 0. 为什么容器化

把「运行时、依赖、目录结构、启动顺序」一次性固化进镜像，让环境差异不再是被怀疑的对象：

- 开发机上跑的配置与内网服务器上跑的是同一份 compose 文件；
- 持久卷（SQLite 库文件 + 隔离区文件 + 备份）与镜像解耦 —— 换镜像不丢数据，搬卷即迁移；
- **运行阶段不执行任何安装**：镜像里只有产物，不受宿主机 Node/全局包影响，也不会因为
  构建期网络抖动在启动时才失败。

> 0007 起为**单平台站内收发**：只有一个镜像、一个服务。原交付网关镜像与 DMZ 侧编排已随需求变更删除。

## 1. 镜像结构（三阶段，运行阶段零安装）

| 阶段 | 做什么 |
|---|---|
| `deps` | `npm ci --no-audit --no-fund`（只依赖 `package.json`/`package-lock.json`/`.npmrc`，源码变更不会让这层失效） |
| `builder` | `npm run build`（= `next build` + `scripts/assemble-standalone.mjs`，把 `static`/`public`/`drizzle` 组装进 standalone） |
| `runtime` | **只 COPY 产物**：`.next/standalone` + `db/*.mjs` + `scripts/migrate.mjs`/`backup.mjs` + `package.json`；非 root uid 10001 |

所以容器里的启动路径是：`entrypoint-platform.sh` → `node scripts/migrate.mjs` → `node server.js`。

**没有** wrangler、**没有** workerd、**没有** `dist/`、**没有**启动时生成配置文件这一步 ——
「不可变镜像」原则因此真正成立：容器启动只做「迁移 + 起服务」两件事。

## 2. 目录与文件

| 文件 | 作用 |
|---|---|
| `docker/Dockerfile.platform` | 平台镜像（三阶段）；`platform` 与 `backup` 两个 service 复用同一镜像 |
| `docker/entrypoint-platform.sh` | 入口：建数据目录 → 迁移（fail-fast）→ `exec node server.js` |
| `docker/ldap/Dockerfile.ldap` | 仅 `--profile dev` 用的测试目录（把 `seed.ldif` 打进镜像，见 §8） |
| `docker/ldap/seed.ldif` | 测试目录种子（zhangsan/lisi/wangwu/zhaoliu），口令 `Passw0rd!<账号名>` |
| `docker-compose.yml` | `platform` + `backup` sidecar + `ldap`（profile `dev`） |
| `.env.docker.example` | 环境变量模板，必填项用 `${VAR:?}` 在 compose 层强制校验 |
| `.dockerignore` | 排除 `node_modules`、`.next`、`.local-data`、`.git`、`.env*`、`*.md`、临时产物 |

### 2.1 两个容易踩的点

- **`.dockerignore` 必须排除 `node_modules` 与 `.next`。** 仓库里的这些目录是在 Windows 上生成的
  （含平台专用二进制），带进 Linux 构建上下文只会拖慢并引入脏数据；镜像内一律重新生成。
- **`.env` 绝不能进镜像。** `.dockerignore` 里的 `.env` / `.env.*` 就是这道闸；
  容器内的配置全部来自 Compose 的 `environment:` 注入。

### 2.2 构建前置条件

- **构建机需要能访问 npm registry**（`deps` 阶段的 `npm ci`）。
- **`package-lock.json` 必须与 `package.json` 同步**，否则 `npm ci` 会以 `EUSAGE` 直接失败
  （报 `Missing: <pkg> from lock file`）。改依赖后先跑 `npm install --package-lock-only`。
- `.npmrc` 必须随构建上下文带进去，Dockerfile 已显式 `COPY`。

## 3. 快速开始（单机起全套）

```bash
cp .env.docker.example .env
# 必填一项：CONFIG_ENCRYPTION_KEY（生成：openssl rand -hex 32）
# 强烈建议同时填 PLATFORM_ADMIN_EMAILS —— 它是「登录必须校验域密码」的开关，见 §6
docker compose up -d --build          # 平台 + 备份 sidecar
docker compose --profile dev up -d    # 再带一个测试用 LDAP（仅开发/联调）
```

| 地址 | 用途 |
|---|---|
| http://<本机内网IP>:8787 | 平台（`.env` 中 `PLATFORM_BIND=0.0.0.0` 时内网同事可直接访问；填 `127.0.0.1` 则只有本机能开） |
| `127.0.0.1:8787/healthz` | 存活探针（进程活着就 200） |
| `127.0.0.1:8787/readyz` | 就绪探针（库可读写 + 存储目录可写） |
| ldap://127.0.0.1:389 | 测试 LDAP（`--profile dev` 才有） |

镜像自带 `HEALTHCHECK`（打 `/healthz`），用 `docker compose ps` 看健康状态。

> ⚠️ **改了 `PLATFORM_BIND` 也不一定能通。** Docker Desktop 会在「域(Domain)/公用(Public)」网络下
> 自动创建 `Docker Desktop Backend` 的入站 **Block** 规则（针对 `com.docker.backend.exe`），而 Windows
> 防火墙里**显式 Block 优先于 Allow** —— 所以还需以**管理员身份**运行一次
> `scripts/open-lan-access.ps1`（放行 8787 并停用那两条 Block，`-Revert` 可完整回滚）。
> 本机实测：域认证网络下不加这条规则，其它机器是连不上的。

## 4. 持久卷与数据

`/data` 被拆成**三个按用途划分的卷**，备份边界因此是明确的：

| 卷 | 容器路径 | 内容 | 丢了会怎样 |
|---|---|---|---|
| `platform-db` | `/data/db` | `platform.db`（SQLite，WAL 模式，含 `-wal`/`-shm`） | 业务数据全丢 |
| `platform-files` | `/data/files` | 隔离区对象（按 objectKey 落盘，含 `.meta.json`） | 文件全丢（审计记录仍在） |
| `platform-backups` | `/data/backups` | 备份产物（数据库快照 + 文件增量镜像） | 只是丢备份副本 |

> `CONFIG_ENCRYPTION_KEY` 不再落盘 —— 它由 Compose 注入环境变量。**请单独离线备份这个值**，
> 它不在任何卷里，删了 compose 文件等于丢了它。

### 4.1 备份：优先用内置 sidecar，而不是 tar 卷

`backup` service 复用平台镜像，循环调用 `scripts/backup.mjs`：

- 数据库：走 SQLite 官方**在线备份 API**（`node:sqlite` 的 `backup()`）—— 不停服、**不会漏掉未 checkpoint 的 WAL**；
- 文件：增量镜像到 `/data/backups/files`（按 size+mtime 判重，不做多份快照，避免吃满磁盘）；
- 保留策略：数据库快照默认保留最近 14 份（`BACKUP_KEEP`），周期默认 24h（`BACKUP_INTERVAL_SECONDS`）。

```bash
docker compose exec backup node scripts/backup.mjs            # 立刻做一次
docker compose logs --tail=50 backup                          # 看历史
```

也可以把备份输出指到宿主机/备份盘：改 compose 里 `platform-backups` 的挂载为宿主机目录即可。

**为什么不 `tar` 整个卷**：平台在跑时直接拷 `platform.db` 会漏掉 `-wal` 里尚未合并的写入，
恢复出来可能缺最近的记录。

## 5. 安全边界

局域网内单段部署：`approval-zone` 一个 bridge 网络装平台与目录服务。

| 源 | 目标 | 端口 | 用途 |
|---|---|---|---|
| 办公网段 | 平台 | 443 | 用户访问（前置 HTTPS 反向代理） |
| 平台 | AD/LDAP | 389/636 | 用户与组同步 + **域账号登录 bind** |
| 平台 | 无 | — | 平台不出网；没有对外交付链路 |

登录收口（重要）：

- 配置了 `PLATFORM_ADMIN_EMAILS` 后，「本地管理员」兜底登录与自声明邮箱登录**同时失效**，
  只剩「域账号 + 域密码」一条路 —— 这是「必须输密码」的落点。
- **生产必须配置 `PLATFORM_ADMIN_EMAILS`**，并且 LDAP 认证源必须指向真实 AD；
  否则任何人都能用自声明邮箱登录，等于可冒用任意身份收发文件。
- 域账号登录建议开 LDAPS（636）或 StartTLS，否则密码明文过网；失败锁定阈值见 §7 变量矩阵。

## 6. 环境变量（容器侧）

| 变量 | 必填 | 说明 |
|---|---|---|
| `CONFIG_ENCRYPTION_KEY` | **是** | 会话签名 + LDAP 密码加密。上线后**不可更换**，离线备份 |
| `PLATFORM_ADMIN_EMAILS` | **是**（生产） | 管理员名单。配置后兜底登录/自声明登录同时禁用 |
| `PLATFORM_APPROVER_EMAILS` / `PLATFORM_AUDITOR_EMAILS` | 建议 | 审批人 / 审计员名单（与「角色管理」页双轨生效） |
| `DATA_DIR` | 否 | 容器内固定 `/data`（compose 已写死） |
| `ALLOW_SELF_DECLARED_LOGIN` | 否 | 仅在联调时设 `true`；默认 = 未配置 `PLATFORM_ADMIN_EMAILS` 时放开 |
| `LOGIN_MAX_FAILURES` / `LOGIN_LOCK_MINUTES` | 否 | 登录失败锁定阈值，默认 5 次 / 15 分钟 |
| `QUARANTINE_RETENTION_DAYS` | 否 | 隔离区文件保留天数，默认 7 |
| `LDAP_PAGE_SIZE` | 否 | 搜索分页每页条目数，默认 500；`0` 关闭（AD 单次上限默认 1000 条） |
| `LDAP_TLS_REJECT_UNAUTHORIZED` | 否 | LDAPS 是否严格校验证书；自签名内网 AD 保持 `false` |
| `BACKUP_INTERVAL_SECONDS` / `BACKUP_KEEP` | 否 | 备份周期与数据库保留份数 |
| `PLATFORM_BIND` | 否 | 宿主机绑定地址。`0.0.0.0` = 内网各机器均可访问（本平台默认配置）；`127.0.0.1` = 仅本机；也可填具体网卡地址收窄范围 |
| `IMAGE_TAG` | 否 | 镜像标签，回滚时指定上一版本 |

## 7. 构建、升级与回滚

```bash
IMAGE_TAG=v1.2.0 docker compose build          # 构建并打标签
IMAGE_TAG=v1.2.0 docker compose up -d          # 升级
IMAGE_TAG=v1.1.0 docker compose up -d          # 回滚（数据在卷里不受影响）
```

- **数据库迁移在启动时自动执行**（entrypoint → `node scripts/migrate.mjs`）。执行器按
  `drizzle/*.sql` 目录清单逐条应用，已在 `__platform_migrations` 表登记过的会跳过，**幂等**。
  应用内首次访问数据库时也会跑同一份逻辑（共用 `db/*.mjs`），两条路径不会出现清单不一致。
- **新增迁移不再需要改任何清单**：改 `db/schema.ts` → `npm run db:generate` → 重建镜像即可。
  （旧版需要同步维护 `entrypoint-platform.sh` 的 `--files` 与 `local-setup.ps1`，还要升 marker ——
  那套机制已随重构废除。）
- **`CONFIG_ENCRYPTION_KEY` 不可轮换**：一旦更换，所有会话失效且已存 LDAP 密码无法解密。

## 8. LDAP 测试目录（`--profile dev`）

- 种子 `docker/ldap/seed.ldif` 被 `COPY` 进自定义镜像 `docker/ldap/Dockerfile.ldap`。
  **不要改成单文件 bind mount**：osixia 引导脚本会对自己 `sed -i` 原地改写，
  单文件挂载不支持 rename，容器会直接崩（`Device or resource busy`）。
- **种子只在空卷首次引导时导入**。改了种子不会补导，需重建目录卷：

```bash
docker compose --profile dev rm -sf ldap
docker volume rm transfer-approval-platform_ldap-data transfer-approval-platform_ldap-config
docker compose --profile dev up -d --build ldap
```

> ⚠️ **千万不要 `down -v`** —— 那会把 `platform-db` / `platform-files` 业务数据一起删掉。

- 口令口径两套，**勿混用**：容器 openldap 是 `Passw0rd!<账号名>`；本地 mock（3890）是「口令 = 账号名」。

**容器内配置链路（首启手工配一次）**：用兜底 `local:true` 登录 → PUT `/api/admin/config`
把认证源指向**服务名** `ldap:389`（`bindDn=cn=admin,dc=example,dc=local`，字段名 `secret`）→
POST `/api/ldap/sync` → 管理页配角色。

## 9. 自检与验收

### 9.1 脚本清单（脚本在宿主机跑，打容器地址即可）

| 脚本 | 覆盖范围 |
|---|---|
| `node scripts/check-sha256.mjs` | 流式 SHA-256 实现与 Node crypto 的一致性（11 项，不需要服务） |
| `node scripts/e2e-internal-transfer.mjs --base <平台>` | **站内收发闭环**：提交 → 审批 → 送达 → 下载 → 撤回（25 项；加 `--mock-ldap` 为 29 项） |
| `node scripts/smoke-test.mjs --base <平台> --admin … --approver … --requester … --write` | 平台接口契约 + 可见性口径（26 项） |
| `node scripts/verify-content-type.mjs --base <平台>` | 内容类型防伪装（26 项） |
| `node scripts/test-ldap-login.mjs --base <平台> --ldap-port 3890` | 域账号登录专项（18 项，需要 mock LDAP） |

> 除 `check-sha256` 外都会**真实写入**业务数据与审计，请在验收环境跑，不要打生产。

对已部署容器跑（真实 LDAP，不走 mock）：

```bash
node scripts/e2e-internal-transfer.mjs --base http://127.0.0.1:8787 \
  --requester lisi --requester-password 'Passw0rd!lisi' \
  --approver wangwu --approver-password 'Passw0rd!wangwu' \
  --recipient zhaoliu --recipient-password 'Passw0rd!zhaoliu' \
  --admin zhangsan --admin-password 'Passw0rd!zhangsan'
```

> 容器里的平台**访问不到宿主机上的 mock LDAP**（容器内的 `127.0.0.1` 是它自己），
> 所以对容器跑不要用 `--mock-ldap`；要么连真实 AD，要么用 `--profile dev` 的 LDAP 容器。

### 9.2 2026-09-24 容器实测结论（全绿）

| 项 | 结果 |
|---|---|
| `docker compose build` | EXIT=0，`platform` 与 `backup` 两个 target 均成功 |
| `docker compose --profile dev up -d` | 三容器 `Up`，`platform` 与 `ldap` 均 `healthy` |
| 容器内启动 | entrypoint 迁移 9 个 → `node server.js` 就绪；`/healthz` 200、`/readyz` 200 |
| 数据布局 | `/data/db/platform.db`（含 WAL）、`/data/files`、`/data/backups`，属主 `app`（非 root） |
| 目录同步（对真实 openldap） | 写入 4 人，`account` 与 `displayName`（张三/李四/王五/赵六）均正确 |
| `e2e-internal-transfer.mjs` | **25/25** |
| `smoke-test.mjs --write` | **26/26** |
| `backup` sidecar | 热备入库 + 文件增量镜像写入 `/data/backups` 正常 |

### 9.3 上线验收清单

- [ ] 镜像构建成功，`docker compose ps` 显示 `healthy`
- [ ] 平台容器重启后会话仍有效（验证 `CONFIG_ENCRYPTION_KEY` 未变）
- [ ] 容器重建（`down` 后 `up`，卷保留）后业务数据不丢
- [ ] 按 §9.1 对容器跑 `e2e-internal-transfer.mjs`，全部通过
- [ ] 用真实 AD 的域账号 + 域密码登录成功；密码错误被拒且失败计数递增；连续失败触发锁定
- [ ] 未配置/配置 `PLATFORM_ADMIN_EMAILS` 两种状态下，兜底登录与自声明登录的开关行为符合预期
- [ ] 发送 → 审批 → 收件人下载 → 撤回 全部在页面走通，审计台账哈希链连续
- [ ] 内容类型防护：改后缀提交被拒（403 格式不正确）、未知类型转人工、三档切换生效
- [ ] `backup` sidecar 至少成功执行过一次，且备份库能打开

## 10. 常用排障

```bash
docker compose logs -f --tail=100 platform      # 入口脚本每步都有 [entrypoint] 前缀
docker compose ps                               # 看 healthy / 端口
docker compose exec platform ls -la /data       # 确认三个卷都挂上了
docker compose exec platform sh -c 'node scripts/migrate.mjs --status'   # 迁移状态
curl -s http://127.0.0.1:8787/readyz            # 就绪探针（含 dataDir/密钥是否配置）
```

| 现象 | 排查方向 |
|---|---|
| `docker compose build` 在 `npm ci` 失败（`EUSAGE`） | `package-lock.json` 与 `package.json` 不同步；跑 `npm install --package-lock-only` |
| 容器启动即退出 | 缺 `CONFIG_ENCRYPTION_KEY`（compose 层 `${VAR:?}` 会直接拒绝启动） |
| 迁移报"找不到迁移目录" | `.next/standalone/drizzle` 没被组装进去；确认 `npm run build` 跑完了 `assemble-standalone.mjs` |
| `/readyz` 报存储不可写 | `/data/files` 卷权限或未挂上；容器以 uid 10001 运行，卷属主需可写 |
| 平台能起但下载不到文件 | 检查 `/data/files` 卷；`readyz` 的 `dataDir` 应显示 `/data` |
| 登录页只提供「本地管理员」 | `PLATFORM_ADMIN_EMAILS` 没注入（此时是联调态） |
| 域账号登录全部失败 | LDAP 认证源配置或网络不通；用「LDAP 与权限」页的**认证自检**卡片定位（跑同一条 bind 链路，不计入锁定）；容器内 host 写服务名 `ldap` 而不是 `127.0.0.1` |
| 登录被锁定（429） | 等 `LOGIN_LOCK_MINUTES` 分钟，或调 `LOGIN_MAX_FAILURES` |
| 重启后所有人被登出 | `CONFIG_ENCRYPTION_KEY` 变了；检查 compose 文件与注入的环境变量 |
| 备份容器一直重启 | 数据库还不存在时 `backup.mjs` 会以非 0 退出（sidecar 的循环里已容错，只记一行日志）；如持续重启看 `docker compose logs backup` |
