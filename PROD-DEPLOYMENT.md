# 生产部署与运维

> 本文面向内网正式部署：拓扑、变量、上线步骤、迁移/备份/恢复、监控与回滚。
> 容器细节见 `DOCKER-DEPLOYMENT.md`，本地联调见 `LOCAL-DEPLOYMENT.md`，架构见 `DEVELOPMENT.md`。
>
> **2026-09-24 起运行时是标准 Node**：生产启动方式只有 `node .next/standalone/server.js`。
> 旧版「`wrangler dev --local` 拉起 workerd」的说法已作废 —— 旧架构没有真正的生产启动方式，
> 只能把开发服务器当生产进程用，这正是本次重构要消除的问题之一。

## 1. 部署拓扑

```
办公网段
   │  HTTPS（建议前置反向代理，收口证书与访问控制）
   ▼
┌─────────────────────────────────────────────┐
│ 单台内网服务器（Linux + Docker）              │
│                                             │
│  approval-zone (bridge)                     │
│   ├── platform   :8787   平台（非 root）      │
│   ├── backup     —       备份 sidecar        │
│   └── ldap       :389    仅 --profile dev    │
│                                             │
│  卷：platform-db / platform-files / platform-backups │
└─────────────────────────────────────────────┘
   │
   ▼  389 / 636（域账号 bind + 目录同步）
内网 AD / OpenLDAP
```

平台**不出网**：除 LDAP 目录外没有对外依赖，也不需要任何云资源。

## 2. 前置检查清单

- [ ] 服务器已装 Docker + Compose；磁盘按「文件量 × 保留期」预留，并给备份卷留同等空间
- [ ] 与应用网段之间的 443 通；平台到目录服务的 389/636 通
- [ ] 已生成 `CONFIG_ENCRYPTION_KEY`（`openssl rand -hex 32`）并**离线备份**（它不在任何卷里）
- [ ] 已确定管理员域名名单（`PLATFORM_ADMIN_EMAILS`）—— 生产必配，否则等于人人可自声明登录
- [ ] 已确认 `QUARANTINE_RETENTION_DAYS` 与本单位合规要求一致
- [ ] 若 LDAPS 用自签名证书，确认 `LDAP_TLS_REJECT_UNAUTHORIZED=false`（或换成受信证书后设 true）

## 3. 首次上线

```bash
git clone <repo> && cd transfer-approval-platform
cp .env.docker.example .env
vi .env                                  # 至少填 CONFIG_ENCRYPTION_KEY 与 PLATFORM_ADMIN_EMAILS
docker compose up -d --build             # 平台 + 备份 sidecar
docker compose ps                        # 期待 platform 为 healthy
```

然后完成一次「容器内配置链路」：

1. 浏览器打开平台。若 `.env` 里 `PLATFORM_ADMIN_EMAILS` 已填，用其中一个域名账号 + 域密码登录；
   尚未填时可先用「本地管理员」兜底入口进入（联调态）。
2. 进「LDAP 与权限」，把认证源指向真实 AD：
   服务器地址（容器内用**服务名或 IP，不能用 127.0.0.1**）、端口、Base DN、绑定帐号与密码；
   保存后点「认证同步」下发一次目录。
3. 用「认证自检」卡片验证这条 bind 链路（它不计入登录失败锁定）。
4. 配好角色（管理员/审批人/审计员）与审批规则。
5. 用真实域账号走一遍：提交 → 审批 → 收件人下载 → 撤回，并检查审计台账。

## 4. 环境变量矩阵

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `CONFIG_ENCRYPTION_KEY` | **是** | — | 会话签名 + LDAP 密码加密。**上线后不可更换**，离线备份 |
| `PLATFORM_ADMIN_EMAILS` | **是** | — | 管理员名单（逗号分隔）。配置后兜底/自声明登录同时失效 |
| `PLATFORM_APPROVER_EMAILS` | 建议 | — | 审批人名单 |
| `PLATFORM_AUDITOR_EMAILS` | 建议 | — | 审计员名单 |
| `DATA_DIR` | 否 | 容器 `/data` | 数据根目录（compose 已固定） |
| `DB_FILE` / `FILES_DIR` / `MIGRATIONS_DIR` | 否 | 由 `DATA_DIR` 派生 | 单个路径覆盖，一般不用 |
| `PORT` / `HOSTNAME` | 否 | `8787` / `0.0.0.0` | 容器内监听地址 |
| `QUARANTINE_RETENTION_DAYS` | 否 | `7` | 被拒/被驳回文件在隔离区的保留天数 |
| `LOGIN_MAX_FAILURES` | 否 | `5` | 连续失败几次锁定 |
| `LOGIN_LOCK_MINUTES` | 否 | `15` | 锁定分钟数 |
| `ALLOW_SELF_DECLARED_LOGIN` | 否 | 未配管理员名单时为 true | 自声明登录开关，**生产保持 false/不设** |
| `LDAP_PAGE_SIZE` | 否 | `500` | 分页每页条目数；AD 单次上限默认 1000，目录大的单位必须开 |
| `LDAP_TLS_REJECT_UNAUTHORIZED` | 否 | `false` | LDAPS 严格校验证书 |
| `BACKUP_INTERVAL_SECONDS` | 否 | `86400` | 备份周期 |
| `BACKUP_KEEP` | 否 | `14` | 数据库快照保留份数 |
| `PLATFORM_BIND` | 否 | `0.0.0.0` | 宿主机端口绑定地址；`0.0.0.0` 内网全员可达，`127.0.0.1` 仅本机，也可绑具体网卡地址或前置反代 |
| `IMAGE_TAG` | 否 | `latest` | 镜像标签，回滚时使用 |

> 历史变量 `DELIVERY_*` / `GATEWAY_*` 已随「历史外发/交付网关」功能于 2026-09-22 整体移除，**不要再配**。

## 5. 数据、备份与恢复

### 5.1 数据布局

| 卷 | 容器路径 | 内容 |
|---|---|---|
| `platform-db` | `/data/db` | `platform.db`（SQLite，WAL） |
| `platform-files` | `/data/files` | 隔离区对象（按 objectKey 落盘） |
| `platform-backups` | `/data/backups` | 备份产物 |

### 5.2 备份

`backup` sidecar 周期性执行，也可手动触发：

```bash
docker compose exec backup node scripts/backup.mjs
docker compose exec backup node scripts/backup.mjs --no-files     # 只备数据库
docker compose exec backup node scripts/backup.mjs --out /mnt/bak # 输出到挂载的备份盘
```

- 数据库用 SQLite **在线备份 API**（`node:sqlite` 的 `backup()`）：不停服、且**不会漏掉尚未
  checkpoint 的 WAL**（直接 `cp platform.db` 会漏，这是选它的原因）。
- 文件是**增量镜像**到 `backups/files`（按 size+mtime 判重），不做多份快照以免吃满磁盘。
- **不要把备份留在同一块盘**：把 `platform-backups` 换成宿主机目录或网络备份盘。

### 5.3 恢复

```bash
docker compose stop platform
docker compose exec backup node scripts/backup.mjs --no-files   # 先做一份当前状态的快照，防误操作

# 用某个快照覆盖主库（快照是完整的、自洽的 SQLite 文件）
docker compose cp backup:/data/backups/db/platform-<时间戳>.db /tmp/restore.db
docker compose run --rm -v transfer-approval-platform_platform-db:/data -v /tmp:/src \
  alpine sh -c 'cp /src/restore.db /data/db/platform.db && rm -f /data/db/platform.db-wal /data/db/platform.db-shm'

docker compose start platform
curl -s http://127.0.0.1:8787/readyz     # 确认就绪
```

> 恢复数据库后**务必删掉 `platform.db-wal` / `platform.db-shm`**，
> 否则旧 WAL 会和新主库混在一起，产生难以解释的读结果。
> 文件目录的恢复就是把 `backups/files` 同步回 `/data/files`（对象名不变，可直接覆盖）。

## 6. 健康检查与监控

| 端点 | 语义 | 建议用法 |
|---|---|---|
| `/healthz` | 存活：进程能响应就 200，**不碰任何依赖** | 编排重启判据；失败 → 重启容器 |
| `/readyz` | 就绪：SQLite 可读写 + 存储目录可写 | 反代/负载摘流判据；失败 → 摘流量（503） |

`/readyz` **刻意不主动连 LDAP**：认证源配置存在库里、由管理员维护，目录暂时不可达时平台本身
仍可用（已登录会话照常工作）。把整个实例判为未就绪会让所有人被摘流量，属过度反应。
LDAP 连通性由管理页的「认证自检」与登录错误提示反馈。

`/readyz` 会返回 `runtime.dataDir` / `encryptionKeyConfigured` / `adminAllowlistConfigured`，
可用于**快速确认「部署对了没有」**（例如管理员名单忘了注入 —— 此时是联调态，必须立刻修）。

告警建议：`/healthz` 连续失败（容器会被 restart policy 拉起）、`/readyz` 持续 503、
备份最近一次执行时间超过 2 个周期（`docker compose logs backup`）。

## 7. 日常运维

### 7.1 迁移

**新增迁移不需要任何手工步骤**：改 `db/schema.ts` → `npm run db:generate` → 重建镜像上线。
容器启动时 entrypoint 会 `node scripts/migrate.mjs`，按 `drizzle/*.sql` 清单逐条应用，
已登记在 `__platform_migrations` 表的会跳过（幂等）；应用内首次访问数据库时跑的是同一份逻辑。

查状态：

```bash
docker compose exec platform sh -c 'node scripts/migrate.mjs --status'
```

### 7.2 升级与回滚

```bash
IMAGE_TAG=v1.2.0 docker compose build
IMAGE_TAG=v1.2.0 docker compose up -d
docker compose ps                                 # 确认 healthy

IMAGE_TAG=v1.1.0 docker compose up -d             # 回滚（数据在卷里，不受影响）
```

迁移只增不删列、不删数据，因此镜像**可以往回滚**。若某个版本引入了破坏性迁移，
回滚前先用 §5.3 恢复一份对应时间点的备份。

### 7.3 日志

```bash
docker compose logs -f --tail=100 platform    # 入口脚本每步带 [entrypoint] 前缀
docker compose logs -f --tail=100 backup
```

日志已配 json-file 轮转（20MB × 5）。

## 8. 上线验收清单

- [ ] `docker compose ps` 显示 `platform` 为 `healthy`
- [ ] `/readyz` 返回 200，且 `adminAllowlistConfigured: true`（生产必须为 true）
- [ ] 用真实 AD 域账号 + 域密码登录成功；密码错误被拒且失败计数递增；连续失败触发 429 锁定
- [ ] 首页登录入口**没有**「本地管理员」兜底与自声明登录（配置了管理员名单后应消失）
- [ ] 发送 → 审批 → 收件人下载 → 撤回 全流程在页面走通
- [ ] 内容类型防护：改后缀提交被拒（403「文件格式不正确」）、未知类型转人工、三档开关生效
- [ ] 审计台账哈希链连续，导出可用
- [ ] `docker compose exec backup node scripts/backup.mjs` 成功，且备份库能打开
- [ ] 平台重启后：已登录会话仍有效（说明 `CONFIG_ENCRYPTION_KEY` 没变）、业务数据不丢
- [ ] 按 `DOCKER-DEPLOYMENT.md` §9.1 对容器跑一次 `e2e-internal-transfer.mjs`，全部通过

## 9. 常见故障

| 现象 | 排查 |
|---|---|
| 容器启动即退出 | 缺 `CONFIG_ENCRYPTION_KEY`（compose 层 `${VAR:?}` 直接拒绝启动） |
| `/readyz` 报存储不可写 | `/data/files` 卷未挂载或权限不对（容器以 uid 10001 运行） |
| 登录页只有「本地管理员」 | `PLATFORM_ADMIN_EMAILS` 没注入 → 处于联调态，立即补上并重启 |
| 域账号登录全失败 | 认证源配置/网络；用「认证自检」定位；容器内 host 要写服务名或 IP，不能写 `127.0.0.1` |
| 目录同步结果为空 | 目录条目数超过 AD 单次上限（默认 1000）→ 设 `LDAP_PAGE_SIZE`（如 500） |
| 同步出来的人没有姓名/部门 | 目录没回属性值；核对 `lib/ldap-client.ts` 的 `returnAttributeValues: true` |
| 重启后所有人被登出 | `CONFIG_ENCRYPTION_KEY` 变了；核对 compose/环境变量 |
| 备份一直失败 | 数据库尚未创建时 `backup.mjs` 会非 0 退出（sidecar 已容错）；若持续失败看 `docker compose logs backup`，多为卷权限或磁盘满 |
| 磁盘增长快 | 隔离区保留天数过长或文件量大；调 `QUARANTINE_RETENTION_DAYS`，并确认 `backups/files` 不是多份快照而是增量镜像 |

## 10. 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-22 | 「历史外发 / 交付网关」功能整体移除，`DELIVERY_*`/`GATEWAY_*` 变量作废 |
| 2026-09-24 | 运行时由 Cloudflare Workers 迁移到标准 Node（Next standalone + `node:sqlite` + 本地文件系统 + ldapts）；新增 `/healthz`、`/readyz` 与备份 sidecar；迁移改为目录清单驱动 |
