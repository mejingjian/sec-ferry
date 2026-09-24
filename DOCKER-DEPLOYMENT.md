# 容器化部署手册

> 配套文档：部署拓扑、环境变量矩阵、验收与回滚见 `PROD-DEPLOYMENT.md`；本地不装 Docker 的调试方式见 `LOCAL-DEPLOYMENT.md`。
> 本手册只讲「怎么把平台跑在容器里」，并说明哪些结论已经过实测、哪些还待验证。

## 0. 为什么容器化

把「运行时、依赖、目录结构、启动顺序」一次性固化进镜像，让环境差异不再是被怀疑的对象：

- 开发机上跑的配置与内网服务器上跑的是同一份 compose 文件；
- 持久卷（D1 的 SQLite 文件 + R2 的目录 + 加密配置）与镜像解耦 —— 换镜像不丢数据，搬卷即迁移；
- 依赖版本被锁在镜像里（Node 22 + wrangler），不再受宿主机 Node/全局包影响。

> 0007 起为**单平台站内收发**：只有一个镜像、一个服务。原来的交付网关镜像
> （`Dockerfile.gateway` / `entrypoint-gateway.sh`）与 DMZ 侧编排已随需求变更删除。

## 1. 关键决定：运行时是 workerd，不是 Node

**这一条推翻了 `PROD-DEPLOYMENT.md` 早期版本的说法，请以本节为准。**

- 应用通过 Worker 绑定读环境：`env.BUCKET`（R2）、`env.DB`（D1）、`env.PLATFORM_ADMIN_EMAILS` 等。
  只有 Worker 运行时会注入这些绑定。
- `vinext start` 启动的是 Node 生产服务器（`dist/server/prod-server.js`），里面**没有任何**
  D1/R2 绑定逻辑 —— 读该文件全文搜不到 `miniflare` / `D1` / `R2` / `binding`。用它跑这个项目，
  文件存储与数据库访问会在运行期直接失败。
- 因此容器里的启动命令是 `wrangler dev --local`（内部即 workerd），而不是 `vinext start`。

同理，`--local` 模式下的 D1 就是持久卷上的 SQLite 文件、R2 就是持久卷上的目录。这正是
「自持持久卷、不依赖云资源」能够成立的原因。

## 2. 目录与文件

| 文件 | 作用 |
|---|---|
| `docker/Dockerfile.platform` | 平台镜像：多阶段构建，运行阶段只装 `wrangler`（产物已全部打进 `dist/`） |
| `docker/entrypoint-platform.sh` | 入口：准备配置 → 初始化数据库 → 启动 workerd |
| `docker/prepare-runtime-config.mjs` | 生成/更新运行时配置，并把环境变量注入 wrangler 的 `vars`（**仅支持 `--role platform`**） |
| `docker/init-db.mjs` | 幂等地把 `drizzle/*.sql` 应用到本地 D1（靠标记文件判重） |
| `docker/ldap/seed.ldif` | 仅 `--profile dev` 用的测试目录（zhangsan/lisi/wangwu/zhaoliu） |
| `docker-compose.yml` | 平台 + 可选测试 LDAP（内含持久卷与网络） |
| `.env.docker.example` | 环境变量模板，必填项用 `${VAR:?}` 在 compose 层强制校验 |
| `.dockerignore` | 排除 `node_modules`（含平台专用的 workerd 二进制）、`dist`、密钥与本地配置 |

### 2.1 两个容易踩的点

- **`.dockerignore` 必须排除 `node_modules`。** 仓库里的 `node_modules` 是在 Windows 上装的，
  含 `@cloudflare/workerd-windows-64` 这类平台专用二进制；带进 Linux 镜像会直接坏掉。
  镜像里重新 `npm ci`（构建阶段）或只装 `wrangler`（运行阶段）。
- **`prepare-runtime-config.mjs` 会把项目根的 `local.config.json` 换成指向
  `$CONFIG_DIR/local.config.json` 的软链。** 这是为了让加密密钥与会话在容器重建后仍然有效。
  ⚠️ 在开发机上直接跑这个命令会替换本地那份 `local.config.json`，请只在容器内使用。

### 2.2 构建前置条件

- **构建机需要能访问 npm registry**：平台镜像的 builder 阶段执行 `npm run install:ci`，
  该脚本在 Linux 上会走 npm 分支（`--include=dev --include=optional`），需要联网拉包并校验
  `package-lock.json` 里 vinext 的完整性摘要。
- **不要往构建上下文里放 `.sites-runtime/`**：`scripts/execution-profile.mjs` 在找不到
  `.sites-runtime/execution-profile.json` 时返回 `portable`（干净克隆/远端构建分支）。`.dockerignore` 已排除该目录。
- `.npmrc` 必须随构建上下文带进去，Dockerfile 已显式 `COPY`。

## 3. 快速开始（单机起全套）

```bash
cp .env.docker.example .env
# 必填一项：CONFIG_ENCRYPTION_KEY（生成：openssl rand -hex 32）
# 强烈建议同时填 PLATFORM_ADMIN_EMAILS —— 它是「登录必须校验域密码」的开关，见 §5
docker compose up -d --build          # 平台
docker compose --profile dev up -d    # 再带一个测试用 LDAP（仅开发/联调）
```

| 地址 | 用途 |
|---|---|
| http://127.0.0.1:8787 | 平台（默认只绑回环，避免误暴露） |
| ldap://127.0.0.1:389 | 测试 LDAP（`--profile dev` 才有） |

容器带 `HEALTHCHECK`，用 `docker compose ps` 看健康状态。

## 4. 持久卷与数据

平台容器的 `/data` 一个卷装三样东西：

| 路径 | 内容 | 丢了会怎样 |
|---|---|---|
| `/data/state` | D1（SQLite）+ R2（隔离区文件） | 业务数据全丢 |
| `/data/config/local.config.json` | 含 `CONFIG_ENCRYPTION_KEY` | 所有会话失效，已存 LDAP 密码无法解密 |
| `/data/runtime` | wrangler/miniflare 的日志与注册表 | 无影响，可重建 |

**备份 = 备份卷**：

```bash
docker run --rm -v transfer-approval-platform_platform-data:/data -v $PWD:/backup \
  alpine tar czf /backup/platform-data.tgz -C /data .
```

备份含加密密钥，需按密钥等级保管。

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
- 域账号登录建议开 LDAPS（636）或 StartTLS，否则密码明文过网；失败锁定阈值见 §6 变量矩阵。

## 6. 环境变量（容器侧）

| 变量 | 必填 | 说明 |
|---|---|---|
| `CONFIG_ENCRYPTION_KEY` | **是** | 会话签名 + LDAP 密码加密。上线后**不可更换**，离线备份 |
| `PLATFORM_ADMIN_EMAILS` | **是**（生产） | 管理员名单。配置后兜底登录/自声明登录同时禁用 |
| `PLATFORM_APPROVER_EMAILS` / `PLATFORM_AUDITOR_EMAILS` | 建议 | 审批人 / 审计员名单（与「角色管理」页双轨生效） |
| `ALLOW_SELF_DECLARED_LOGIN` | 否 | 仅在联调时设 `true`；默认 = 未配置 `PLATFORM_ADMIN_EMAILS` 时放开 |
| `LOGIN_MAX_FAILURES` / `LOGIN_LOCK_MINUTES` | 否 | 登录失败锁定阈值，默认 5 次 / 15 分钟 |
| `QUARANTINE_RETENTION_DAYS` | 否 | 隔离区文件保留天数，默认 7 |
| `PLATFORM_BIND` | 否 | 宿主机绑定地址，默认 `127.0.0.1`（内网正式部署改审批网段地址） |
| `IMAGE_TAG` | 否 | 镜像标签，回滚时指定上一版本 |

更完整的对照（含平台侧与网关历史变量）见 `PROD-DEPLOYMENT.md` §3 —— 网关相关变量已作废。

## 7. 构建、升级与回滚

```bash
IMAGE_TAG=v1.2.0 docker compose build          # 构建并打标签
IMAGE_TAG=v1.2.0 docker compose up -d platform # 升级
IMAGE_TAG=v1.1.0 docker compose up -d platform # 回滚（数据在卷里不受影响）
```

- **数据库迁移在启动时自动执行**（`docker/init-db.mjs`，标记文件 `/.transfer-platform-schema-v8`，幂等）。
  迁移只增不删列、不删除已有表的数据，因此镜像可以往回滚。
- **`CONFIG_ENCRYPTION_KEY` 不可轮换**：一旦更换，所有会话失效且已存 LDAP 密码无法解密。
- schema 变更的正确姿势：新增 `drizzle/000N_*.sql` → 更新 `entrypoint-platform.sh` 的 `--files` 与 `--marker`。

## 8. 自检与验收

### 8.1 脚本清单（脚本本身不依赖容器，打容器地址即可）

| 脚本 | 是否需要起服务 | 覆盖范围 |
|---|---|---|
| `node scripts/check-sha256.mjs` | 否 | 流式 SHA-256 实现与 WebCrypto 的一致性 |
| `node scripts/test-ldap-login.mjs --base <平台> --ldap-port 3890` | 需要 | 域账号登录专项（短名/邮箱、错误密码、失败锁定） |
| `node scripts/smoke-test.mjs --base <平台> --admin <账号> --approver <账号> --requester <账号> [--write]` | 需要 | 平台接口契约（登录/可见性/规则预判/提交校验） |
| `node scripts/e2e-internal-transfer.mjs --base <平台> [--mock-ldap]` | 需要 | **站内收发闭环**：提交 → 审批 → 送达 → 下载 → 撤回 |
| `node scripts/verify-content-type.mjs --base <平台> [--mock-ldap]` | 需要 | **内容类型防伪装**：改后缀拒绝、未知类型转人工、档位切换（normal/strict/off）、流式大文件 |

对已部署容器跑：

```bash
docker compose --profile dev up -d    # 需要 mock LDAP 时（或另起 scripts/mock-ldap-server.mjs）
node scripts/e2e-internal-transfer.mjs --base http://127.0.0.1:8787 --mock-ldap
node scripts/verify-content-type.mjs --base http://127.0.0.1:8787 --mock-ldap
```

> `e2e-internal-transfer.mjs` 与 `verify-content-type.mjs` 会**真实写入**业务数据与审计，
> 请在验收环境跑，不要打生产。

### 8.2 已在开发机实测的结论（未用容器）

- 三套回归全绿：`e2e-internal-transfer.mjs` **29/29**、`verify-content-type.mjs` **26/26**、
  `smoke-test.mjs`（多角色域账号 + `--write` 真实提交）**26/26**；`test-ldap-login.mjs` **14/14**。
- 覆盖到的关键链路：多选收件人提交 → 规则判定 → 审批通过即送达 → 收件人会话内下载
  （SHA-256 一致、下载次数与首次下载时间落库）→ 撤回后下载 403、送达记录 `enabled=0`；
  登录失败 5 次触发锁定 429；改后缀伪装（PDF→.bin 等）被 403 拒绝、未知类型转人工。
- 运行时形态：`wrangler dev --local`（workerd）+ 卷内 SQLite/D1 + 卷内 R2 目录，全程无云资源依赖。

### 8.3 尚未验证的部分

- **镜像本身尚未构建过**：`docker compose build` 从未执行过（开发机有 Docker CLI 29.8.0 + compose v5.5.1，
  只是没跑过构建）。Dockerfile 与 compose 是照已实测的启动命令写的，但「镜像能构建成功」「容器里能起来」
  「健康检查能转 healthy」需要在带 Docker 的宿主机上实际跑一遍。
- 容器内的 LDAP 联调（`--profile dev` + `seed.ldif`）同样未实测。`seed.ldif` 里的测试用户**带口令**，
  形式为 `Passw0rd!<账号名>`——**与本地 mock 的「口令 = 账号名」口径不同，两者不要混用**。
  容器里登录失败先查「目录卷是不是旧的」（种子只在卷为空、首次启动时导入一次），
  排查命令与重建步骤见 `LOCAL-DEPLOYMENT.md` §5.1。

### 8.4 上线验收清单（8.3 完成后执行）

- [ ] 镜像构建成功，`docker compose ps` 显示 `healthy`
- [ ] 平台容器重启后会话仍有效（验证 `CONFIG_ENCRYPTION_KEY` 已持久化到卷）
- [ ] 容器重建（`down` 后 `up`，卷保留）后业务数据不丢
- [ ] 按 8.1 对容器跑 `e2e-internal-transfer.mjs` 与 `verify-content-type.mjs`，全部通过
- [ ] 用真实 AD 的域账号 + 域密码登录成功；密码错误被拒且失败计数递增；连续失败触发锁定
- [ ] 未配置/配置 `PLATFORM_ADMIN_EMAILS` 两种状态下，兜底登录与自声明登录的开关行为符合预期
- [ ] 发送 → 审批 → 收件人下载 → 撤回 全部在页面走通，审计台账哈希链连续
- [ ] 内容类型防护：改后缀提交被拒（403 格式不正确）、未知类型转人工、三档切换生效


## 9.5 首次容器构建实录（2026-09-23）与故障排查

镜像首次在 Docker Desktop (Windows/WSL2) 上构建并实测通过。过程中发现并修复四个问题：

1. **构建阶段缺 scripts/**：Dockerfile 在 `COPY . .` 之前就跑 `npm run install:ci`（= `node scripts/install-ci.mjs`），必须先 `COPY scripts ./scripts`，否则 MODULE_NOT_FOUND。
2. **运行阶段 wrangler 装不上**：运行阶段 `NODE_ENV=production` 让 npm 隐式 omit=dev，对「已是 devDependency 的显式安装参数」npm 会**静默跳过** → 镜像里没有 wrangler，容器启动即崩（日志：找不到 wrangler）。修复：`npm install --include=dev ...`。
3. **种子 LDIF 不能单文件 bind mount**：osixia/openldap 引导时对 50-seed.ldif 执行 `sed -i`（原地替换域名占位符），单文件挂载不支持 rename → 容器崩溃（Device or resource busy / 只读卷 chown 失败）。修复：新增 `docker/ldap/Dockerfile.ldap` 把 seed.ldif 直接 COPY 进自定义镜像，compose 不再挂载该文件。
4. **typesOnly=TRUE 导致目录同步拿不到属性**：`lib/ldap-client.ts` 搜索请求把 typesOnly 编码成 0xff（TRUE），openldap 只回属性名、值全为空 SET（抓包特征：值集合 `31 00`）→ 同步出「DN 当邮箱、名字未命名」的用户，域账号登录失败。mock LDAP 忽略该标志所以本地回归从未暴露。修复：编码 0x00（FALSE）。

另外：**LDAP 种子只在空卷首次引导时导入**——目录卷已初始化后修种子不会补导。重建测试目录：

```bash
docker compose --profile dev rm -sf ldap
docker volume rm transfer-approval-platform_ldap-data transfer-approval-platform_ldap-config
docker compose --profile dev up -d --build ldap
```

实测结论：`docker compose --profile dev up -d --build` 一次起齐平台+测试 LDAP；兜底管理员登录后把认证源指向服务名 `ldap:389`（bindDn=`cn=admin,dc=example,dc=local`，口令 `admin`）并执行同步，seed 账号（zhangsan/lisi/wangwu/zhaoliu，口令 `Passw0rd!<账号名>`）即可域账号登录。
对容器实测回归：e2e **25/25**（不含 --mock-ldap 专属的切源/还原 4 项）、smoke **26/26**、verify-content-type **21/21**。

## 9. 已知的次要问题

- **`prepare-runtime-config.mjs` 仅支持 `--role platform`**：`--role gateway` 已随网关删除，
  传其它角色会直接报错退出（这是有意为之，避免误配）。
- **`local.config.json` 在容器内是软链**：容器重建后仍指向 `/data/config`，本地开发时不要手动替换。

## 10. 常用排障

```bash
docker compose logs -f --tail=100 platform     # 入口脚本每一步都有 [entrypoint] 前缀
docker compose exec platform ls -la /data      # 确认卷挂上了、配置与数据库都在
docker compose exec platform ls -la /data/state # D1 + R2 都在卷里
```

| 现象 | 排查方向 |
|---|---|
| 平台能起但读不到文件 | R2 绑定目录不在卷里；确认 `PERSIST_DIR` 指向 `/data/state` |
| 登录页只提供「本地管理员」 | `PLATFORM_ADMIN_EMAILS` 没注入（此时是联调态）；看入口日志里 `已注入变量` 一行 |
| 域账号登录全部失败 | LDAP 认证源配置或网络不通；用「LDAP 与权限」页的**认证自检**卡片定位（它跑的是同一条 bind 链路，不计入锁定） |
| 登录被锁定（429） | 等 `LOGIN_LOCK_MINUTES` 分钟，或按 `LOGIN_MAX_FAILURES` 调整阈值 |
| 重启后所有人被登出 | `CONFIG_ENCRYPTION_KEY` 变了或没持久化；检查 `/data/config/local.config.json` |
| 容器启动即退出 | 缺 `CONFIG_ENCRYPTION_KEY`（compose 层 `${VAR:?}` 会直接拒绝启动） |

---

*（内容由 AI 生成，仅供参考）*
