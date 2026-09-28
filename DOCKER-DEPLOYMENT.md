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
cp .env.docker.example .env.docker    # ⚠️ 是 .env.docker，不要覆盖根目录 .env（那是本地开发用的）
# 必填一项：CONFIG_ENCRYPTION_KEY（生成：openssl rand -hex 32）
# 强烈建议同时填 PLATFORM_ADMIN_EMAILS —— 它是「登录必须校验域密码」的开关，见 §6
docker compose --env-file .env.docker up -d --build          # 平台 + 备份 sidecar
docker compose --env-file .env.docker --profile dev up -d    # 再带一个测试用 LDAP（仅开发/联调）
# 等价的 npm 脚本（已内置 --env-file .env.docker）：
#   npm run docker:up / npm run docker:up:dev / npm run docker:build
```

> 容器与本地开发**用两份不同的环境文件**：根目录 `.env` 只给 `npm run dev` / `local:start` 用，
> 容器一律走 `.env.docker`。这样开发机上的密钥不会顺带成为容器的加密密钥 ——
> 一旦开发密钥泄漏，容器里已加密的 LDAP 服务账号口令就跟着失效。两份文件互不影响。

| 地址 | 用途 |
|---|---|
| http://<本机内网IP>:8787 | 平台（`.env.docker` 中 `PLATFORM_BIND=0.0.0.0` 时内网同事可直接访问；填 `127.0.0.1` 则只有本机能开） |
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
> 真丢了不会让平台崩，但库里已存的绑定口令再也解不开 —— 只能清空认证源重新配置
> （§9.5 方案 B）。这也是「离线备份」要单独强调的原因。

### 4.1 备份：优先用内置 sidecar，而不是 tar 卷

`backup` service 复用平台镜像，循环调用 `scripts/backup.mjs`：

- 数据库：走 SQLite 官方**在线备份 API**（`node:sqlite` 的 `backup()`）—— 不停服、**不会漏掉未 checkpoint 的 WAL**；
- **写完立即校验**：0 字节 / 非 SQLite 文件头 / `PRAGMA quick_check` 不通过 / 缺 `__platform_migrations` 表 → 判定失败，
  当场删掉该产物并让本次备份以非 0 退出码结束（校验在临时副本上做，不会在备份目录里留下 `-shm`/`-wal` 副产物）；
- **巡检历史产物**：每轮顺手删掉确定无意义的 0 字节备份与校验副产物；非空但校验不通过的只告警不自动删（交人工判断）；
- 文件：增量镜像到 `/data/backups/files`（按 size+mtime 判重，不做多份快照，避免吃满磁盘）；
- 保留策略：数据库快照默认保留最近 14 份（`BACKUP_KEEP`，只统计 `platform-*.db` 本体，副产物不占名额），
  周期默认 24h（`BACKUP_INTERVAL_SECONDS`）。

> 为什么要校验：备份「命令没报错」不等于**可用**。容器重建 / 宿主重启若正好打断写入，
> 会留下 0 字节或半成品文件；而它会照样被保留策略当成一份有效备份占位 —— 需要恢复时才发现是空的。
> 本机实测确实命中过：`/data/backups/db/platform-20260927-141259.db` 就是 0 字节。

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

### 5.1 容器运行时加固（compose 已内置）

`platform` 与 `backup` 两个服务都按下面这套跑，`docker inspect` 可直接核验：

| 项 | 值 | 作用 |
|---|---|---|
| `read_only: true` | 根文件系统只读 | 镜像不可变，运行期无法写入自身；唯一可写处是 `/data` 卷 |
| `tmpfs: /tmp`、`/app/.next/cache` | 内存临时盘 | Next 运行期需要写缓存/临时文件，给最小可写面 |
| `cap_drop: [ALL]` | 丢弃全部 Linux capabilities | 监听 8787（>1024）不需要 `NET_BIND_SERVICE`，容器也不需要任何特权 |
| `security_opt: no-new-privileges:true` | 禁止提权 | 阻断 setuid/setgid 提权路径 |
| `USER app`（uid 10001） | 非 root 运行 | 镜像内已建独立用户 |

```bash
# 核验加固是否生效
docker inspect transfer-approval-platform-platform-1 \
  --format 'ReadonlyRootfs={{.HostConfig.ReadonlyRootfs}} CapDrop={{json .HostConfig.CapDrop}} SecOpt={{json .HostConfig.SecurityOpt}}'
# 只读根自测：写 /app 应被拒，写 /tmp 应成功
docker compose exec platform sh -c "touch /app/x || echo 只读生效; touch /tmp/x && echo tmpfs 可写"
```

> `ldap` 服务（`--profile dev`）用的是上游 `osixia/openldap` 镜像，其入口脚本需要 `CAP_CHOWN`/`setuid`，
> 因此**没有**套用这套加固 —— 它只用于开发联调的种子目录，生产连真实 AD 时该服务根本不会启用。

## 6. 环境变量（容器侧）

以下变量写在 **`.env.docker`**（由 `docker compose --env-file .env.docker` 加载，参见 §3）。
`.env.docker` 被 `.gitignore` 的 `.env*` 排除；根目录 `.env` 只服务本地开发，别把容器配置写进去。

| 变量 | 必填 | 说明 |
|---|---|---|
| `CONFIG_ENCRYPTION_KEY` | **是** | 会话签名 + LDAP 密码加密。**可轮换**（`npm run rekey`，见 §9.6），但必须离线备份 |
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
IMAGE_TAG=v1.2.0 docker compose --env-file .env.docker build   # 构建并打标签
IMAGE_TAG=v1.2.0 docker compose --env-file .env.docker up -d   # 升级
IMAGE_TAG=v1.1.0 docker compose --env-file .env.docker up -d   # 回滚（数据在卷里不受影响）
```

- **数据库迁移在启动时自动执行**（entrypoint → `node scripts/migrate.mjs`）。执行器按
  `drizzle/*.sql` 目录清单逐条应用，已在 `__platform_migrations` 表登记过的会跳过，**幂等**。
  应用内首次访问数据库时也会跑同一份逻辑（共用 `db/*.mjs`），两条路径不会出现清单不一致。
- **新增迁移不再需要改任何清单**：改 `db/schema.ts` → `npm run db:generate` → 重建镜像即可。
  （旧版需要同步维护 `entrypoint-platform.sh` 的 `--files` 与 `local-setup.ps1`，还要升 marker ——
  那套机制已随重构废除。）
- **`CONFIG_ENCRYPTION_KEY` 可以轮换**：用 `npm run rekey`（见 §9.6）在单事务内把库里所有配置密文
  重加密到新密钥。**不要**手工只改环境变量 —— 那会留下一批解不开的旧密文。
  轮换后所有会话失效（会话 Cookie 也用这把密钥签名），需重新登录，这是预期行为。

## 8. LDAP 测试目录（`--profile dev`）

- 种子 `docker/ldap/seed.ldif` 被 `COPY` 进自定义镜像 `docker/ldap/Dockerfile.ldap`。
  **不要改成单文件 bind mount**：osixia 引导脚本会对自己 `sed -i` 原地改写，
  单文件挂载不支持 rename，容器会直接崩（`Device or resource busy`）。
- **种子只在空卷首次引导时导入**。改了种子不会补导，需重建目录卷：

```bash
docker compose --env-file .env.docker --profile dev rm -sf ldap
docker volume rm transfer-approval-platform_ldap-data transfer-approval-platform_ldap-config
docker compose --env-file .env.docker --profile dev up -d --build ldap
```

> ⚠️ **千万不要 `down -v`** —— 那会把 `platform-db` / `platform-files` 业务数据一起删掉。

- 口令口径两套，**勿混用**：容器 openldap 是 `Passw0rd!<账号名>`；本地 mock（3890）是「口令 = 账号名」。

**容器内配置链路（首启手工配一次）**：用兜底 `local:true` 登录 → PUT `/api/admin/config`
把认证源指向**服务名** `ldap:389`（`bindDn=cn=admin,dc=example,dc=local`，字段名 `secret`）→
POST `/api/ldap/sync` → 管理页配角色。

> ⚠️ 这条链路要求首启时 `.env.docker` 里的 `PLATFORM_ADMIN_EMAILS` **先留空**（联调态才有兜底入口）。
> 认证源与角色配好、`test-bind` 通过后，再填上管理员名单并重建，才算真正退出联调态 ——
> 一上来就填的话，兜底入口已关而 LDAP 还没配，会没有任何登录路径。

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

### 9.3 2026-09-28 加固与生产化配置实测（全绿）

在既有容器上补齐「运行时加固 + 容器独立密钥 + 退出联调态 + 备份产物校验」后的实测结论：

| 项 | 结果 |
|---|---|
| `docker compose --env-file .env.docker up -d --build` | 构建成功；`platform`/`backup` 重建后 `Up (healthy)` |
| 运行时加固 | `ReadonlyRootfs=true`、`CapDrop=["ALL"]`、`SecurityOpt=["no-new-privileges:true"]`、`User=app`；`/app` 写入被拒、`/tmp`（tmpfs）可写 |
| 容器独立密钥 | `CONFIG_ENCRYPTION_KEY` 与根 `.env` 的开发密钥**不同源**；切换后重新提交 LDAP 配置，密文在新密钥下重加密成功 |
| LDAP 链路 | `POST /api/ldap/test-bind` 对 `zhangsan` 返回 `matchedBy=search`（服务账号搜索 + 用户 bind 均通）；`POST /api/ldap/sync` 写入 4 人、停用 0 人 |
| 退出联调态 | `PLATFORM_ADMIN_EMAILS` 配置后 `readyz.adminAllowlistConfigured=true`；`local:true` 兜底登录返回 403；自声明邮箱登录返回 422（要求域密码） |
| 域账号登录与角色 | `zhangsan` → 管理员、`wangwu` → 审批人、`lisi` → 发起人，均 200 |
| 备份产物校验 | 容器内 `backup.mjs` 输出「已校验可打开」；sidecar 启动日志显示自动清掉 2 份历史 0 字节产物 |
| `e2e-internal-transfer.mjs` | **25/25** |
| `smoke-test.mjs --write` | **26/26** |

> 换 `CONFIG_ENCRYPTION_KEY` 现在有工具支持（见 §9.6）：`npm run rekey` 会把库里所有密文一步重加密，
> 不必手工重提交口令。下面这套手工顺序仍然有效，适用于**还没有密文**（首次部署）或作为备用手段：
> ① 先只换密钥、`PLATFORM_ADMIN_EMAILS` 保持为空 → 重建 → 用 `local:true` 兜底会话
> `PUT /api/admin/config` 把 LDAP 服务账号口令重新提交一次（新密钥下重加密）；
> ② 验证 `test-bind` + `sync` 通过后，再配置 `PLATFORM_ADMIN_EMAILS` 并重建。
> 顺序颠倒的话：兜底入口已关、旧密文又解不开，将没有任何登录路径。

### 9.4 上线验收清单

- [ ] 镜像构建成功，`docker compose ps` 显示 `healthy`
- [ ] 平台容器重启后会话仍有效（验证 `CONFIG_ENCRYPTION_KEY` 未变）
- [ ] 容器重建（`down` 后 `up`，卷保留）后业务数据不丢
- [ ] 按 §9.1 对容器跑 `e2e-internal-transfer.mjs`，全部通过
- [ ] 用真实 AD 的域账号 + 域密码登录成功；密码错误被拒且失败计数递增；连续失败触发锁定
- [ ] 未配置/配置 `PLATFORM_ADMIN_EMAILS` 两种状态下，兜底登录与自声明登录的开关行为符合预期
- [ ] 发送 → 审批 → 收件人下载 → 撤回 全部在页面走通，审计台账哈希链连续
- [ ] 内容类型防护：改后缀提交被拒（403 格式不正确）、未知类型转人工、三档切换生效
- [ ] `backup` sidecar 至少成功执行过一次，日志出现「已校验可打开」；备份目录无 0 字节产物
- [ ] `docker inspect` 复核运行时加固：`ReadonlyRootfs=true`、`CapDrop=["ALL"]`、`no-new-privileges`
- [ ] 密钥轮换可用：`npm run test:rekey` 全部通过；容器内 `docker compose exec platform node scripts/rekey.mjs` 能跑出只读审计
- [ ] 故意制造一次配置错误，确认启动前自检会以可读的中文提示阻止启动（见 §9.5）

### 9.5 锁死后如何恢复（break-glass）

**什么情况会「锁死」。** 配置了 `PLATFORM_ADMIN_EMAILS` 之后，本地兜底登录与自声明登录会**立即失效**，
界面只剩「LDAP 域账号 + 域密码」一条路。于是下面任一情况都会让人连管理页都进不去 —— 也就无法改配置自救：

- LDAP 服务器不可达（网络 / 防火墙 / 证书变更）；
- `CONFIG_ENCRYPTION_KEY` 被更换，导致库里已存的绑定口令**解不开**；
- 绑定用的服务账号被域控禁用或改密。

**第一步：先诊断，别急着改数据。** 这个工具直接读写数据目录里的 SQLite，**不依赖服务进程**，
平台起不来时照样能用：

```bash
npm run admin:inspect        # 等价于 node --env-file-if-exists=.env scripts/reset-admin.mjs
```

它会打印环境侧变量、库内认证源配置、角色分配，并给出结论 —— **当前到底有哪几条登录路径**。
若提示「没有任何可用的登录路径」，再按下面处理。

**恢复方案（按推荐顺序）**

| 方案 | 适用 | 做法 |
|---|---|---|
| **A. 临时清空管理员名单**（推荐，不动数据） | 通用 | 把 `PLATFORM_ADMIN_EMAILS` 临时置空 → 重建容器 → 用页面上的兜底管理员进入「LDAP 与权限」重新配置认证源 → 配好后再把名单填回来并重建 |
| **B. 清掉坏掉的认证源配置** | 认证源已无法修复 | `node scripts/reset-admin.mjs --clear-ldap --yes`，再按方案 A 进入页面重配 |
| **C. 用旧密钥把密文重加密回当前密钥** | 确认是换过密钥导致密文解不开 | `npm run rekey -- --old-key <加密它们的那把> --new-key <当前环境用的> --yes`（见 §9.6）。**不必**清配置重填口令 |
| **D. 直接补一个管理员** | 只是角色丢了 | `node scripts/reset-admin.mjs --grant you@corp.local`（前提是 LDAP 可达，否则仍登不进去） |

> ⚠️ **顺序不能颠倒**：必须**先填好认证源，再配置 `PLATFORM_ADMIN_EMAILS`**。
> 反过来做就会制造出「兜底入口已关、旧密文又解不开」的死局。
> 换密钥时同理：先只换密钥、名单留空 → 重新提交 LDAP 口令并验证 → 最后才配名单。

**启动前自检（preflight）会把这类错误拦在启动那一刻。** 容器启动与 `npm run preflight` 都会检查：
密钥是否缺失或仍是占位符、数据目录是否可写、以及**「已配管理员名单但认证源为空」这个死局**。
不通过时以可读的中文提示阻止启动（紧急情况可用 `SKIP_PREFLIGHT=1` 绕过）。
这样问题的表现形式就是「容器起不来 + 明确原因」，而不是「登录莫名其妙失败」。

### 9.6 密钥轮换（rekey）

`CONFIG_ENCRYPTION_KEY` 用在两处：配置密文（LDAP 绑定口令、SMTP 发信口令）与会话 Cookie 签名。
它**可以轮换** —— `scripts/rekey.mjs` 会在单个事务里把库里所有密文从旧密钥重加密到新密钥。
（此前这一步只能「换回去」或重建环境，密钥泄漏时没有补救手段。）

```bash
# 容器部署的推荐顺序
npm run rekey                                              # ① 只读审计：列出密文，判定当前密钥能否解开
docker compose --env-file .env.docker stop platform        # ② 停平台（见下方「为什么必须先停」）
docker compose --env-file .env.docker run --rm platform \
  node scripts/rekey.mjs --generate --env-file /data/rekey.env --yes   # ③ 生成新密钥并轮换
# ④ 把新密钥填进 .env.docker 的 CONFIG_ENCRYPTION_KEY，再 up -d
```

> 容器是只读根文件系统，`--env-file` 写不进 `/app`。更省事的做法是在宿主机跑 `npm run rekey`
> 并用 `--env-file .env.docker` 就地更新，或用 `docker compose exec platform node scripts/rekey.mjs`
> 配合 `--print-key`，把密钥手工填进 `.env.docker`。

**为什么必须先停平台**：正在运行的进程会把解出来的口令缓存在内存里，并在下次保存配置时
**用旧密钥**重新加密 —— 那会在轮换后再写入一份旧密钥密文。脚本会探测 8787 端口并在发现平台
仍在运行时显著告警，但不会替你停它。

**脚本替你做的事**（都是手工容易漏的）：

| 步骤 | 说明 |
|---|---|
| 写前快照 | 复用与备份同一份逻辑生成**已校验**的数据库快照（`platform-prerekey-*.db`）；快照失败即拒绝动手 |
| 事务内重加密 | 全部密文先解密成功才开写；任一步失败整体 `ROLLBACK`，不留「一半新一半旧」的库 |
| 写前自校验 | 每条新密文先解回原文比对通过才落库 |
| 提交后复核 | 从库里读回，逐条确认「新密钥可解、旧密钥不可解」 |
| 审计留痕 | 与本次变更**同事务**写入 `audit_events`（对象 `SECRET_KEY`），哈希链接在既有链之后 |
| 兜底扫描 | 全库扫描「像密文但未登记」的字段并告警 |
| 配置回写 | `--env-file` 指定时把新密钥写回该文件，并留一份 `.bak-<时间戳>` |

**新增加密字段时必须登记**：`scripts/rekey.mjs` 顶部的 `CIPHERTEXT_TARGETS`。
漏登记不会报错，只会表现为「轮换后某个配置读不出来」—— 所以脚本会做上面那条兜底扫描。

**其他**：

- 会话 Cookie 也由这把密钥签名，轮换后所有人被登出、需重新登录（预期行为）。
- 命令行传密钥会留在 shell 历史里：优先用 `--generate`，或用 `--new-key-file <path>`。
- 密文格式是 `<24位hex IV>.<密文hex>`，改动格式会让存量密文全部解不开 —— `npm run test:rekey`
  里有一条格式契约断言专门守这个。
- 回归：`npm run test:rekey` —— 它用**全新空库 + 人造密文**演练，不碰真实数据，可随时跑。

### 9.7 密钥离线备份的标准做法

密钥不在任何卷里，丢了只能清空认证源重配 —— 所以离线备份是必做项。推荐做法：

1. **打印指纹**：在部署机执行 `npm run rekey -- --fingerprint`，得到形如
   `9472-DCA7-3865-CA5D` 的 16 位指纹（当前密钥 SHA-256 的前 16 位）。
2. **备份内容**：把**指纹 + 密钥本身**存进离线密码管理器（或打印密封）。只存指纹不存密钥等于没备份；
   只存密钥则日后无法当场确认「手里这把还是不是线上那把」。
3. **定期核对**：轮换后（§9.6）重新打印指纹并更新备份记录；核对时执行 `--fingerprint`
   与记录里的值比对即可，全程不显示密钥内容。

> 反例（真实发生过）：在仓库根目录手工维护一个 `.env.key-backup.txt` 明文密钥文件 ——
> 它虽被 `.gitignore` 覆盖，但会随「打包 zip 发人」「整目录复制/上传网盘」一起泄漏。
> 密钥只应存在于：运行环境变量 + 离线密码管理器。

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
| 备份报「校验失败，已删除该产物」 | 写入过程被打断（容器重建/宿主重启）。补跑一次即可；若反复出现，查磁盘是否写满 |
| 备份日志出现「N 份历史备份未通过校验」 | 历史遗留的坏产物，脚本只告警不自动删（非空的交人工判断）；确认无用后手工删除 |
| **全新部署后完全无法登录** | `PLATFORM_ADMIN_EMAILS` 已配但 LDAP 认证源还没配：兜底与自声明入口都关了，且没有可用的 LDAP。首启请先留空该变量 → 用兜底入口配好认证源与角色 → 再填上并重建（顺序见 §9.3 提示） |
