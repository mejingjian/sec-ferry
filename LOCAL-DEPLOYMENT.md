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

# 内网文件安全收发平台：本地测试部署

> 配套文档：单平台局域网生产部署见 `PROD-DEPLOYMENT.md`，容器化见 `DOCKER-DEPLOYMENT.md`。
>
> ⚠️ 形态已变：0007 起为**单平台站内收发**（文件发送 → 审批 → 送达站内收件人），
> 原来的「外发申请 + 交付网关 + 匿名外链下载」已整体下线。本地不再需要 `local:gateway`。

## 1. 环境要求

- Windows 10/11 或 Windows Server
- Node.js 22.13 或更高版本
- PowerShell 5.1 或更高版本
- 建议至少保留 2 GB 磁盘空间

本地模式使用 Wrangler 提供的 D1 与 R2 模拟环境，不需要 Cloudflare 账号，也不需要 Docker。

## 2. 第一次初始化

在项目目录打开 PowerShell：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
npm run local:setup
```

脚本会安装依赖、构建项目、生成本地加密密钥，并把 `drizzle/0000 ~ 0008` 应用到本地库
（**没有 0004**，按文件名顺序执行，禁止跳过）。密钥保存在被 Git 忽略的 `local.config.json` 中。

初始化完成后，持久化目录里会出现标记文件 `.transfer-platform-schema-v8`（迁移判重靠它）。

## 3. 启动平台

```powershell
npm run local:start
```

浏览器打开 <http://127.0.0.1:8787>。

启动脚本的行为：

- 先检查标记文件（兼容 v2~v8）判断是否已初始化，未初始化会提示先跑 `local:setup`；
- 再比较 `dist/server/wrangler.json` 与 `app/ lib/ components/ db/ hooks/` 下源文件的修改时间，
  **只在产物缺失或源文件更新时才重新构建**（`vinext build` 会先清空 `dist`，运行中重建会把 8787 打成 502）；
- 最后以 `wrangler dev --local` 启动 workerd，绑定 `127.0.0.1:8787`。

停止服务：在运行窗口按 `Ctrl+C`。若服务是以管理员身份启动的（workerd 会继承提权令牌，普通 `taskkill` 会被拒绝），用：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/stop-dev-server.ps1
```

## 4. 登录方式

平台提供独立登录页（`/login`），三条路径：

| 路径 | 触发条件 | 说明 |
|---|---|---|
| **域账号 + 域密码** | 已配置 LDAP 认证源 | 主路径：账号（`zhangsan`）或邮箱 + 域密码，走 LDAP simple bind 校验（见 `PROD-DEPLOYMENT.md` §4.4） |
| 本地兜底「本地管理员」 | **未**配置 `PLATFORM_ADMIN_EMAILS` | 初始化/联调用；生产一旦配置了管理员名单即自动禁用 |
| 自声明邮箱（不校验密码） | LDAP **未**配置，或显式 `ALLOW_SELF_DECLARED_LOGIN=true` | 仅联调态可用；审计里会打 `SELF_DECLARED` 警告 |

> 三者是递进收口的：配置 `PLATFORM_ADMIN_EMAILS`（生产必须）后，只剩「域账号 + 域密码」一条路。

## 5. 本地联调域账号登录（mock LDAP）

本地没有真实 AD，用自带的零依赖 mock LDAP 跑通全链路：

```powershell
node scripts/mock-ldap-server.mjs --port 3890
```

- 测试账号：`zhangsan` / `lisi` / `wangwu` / `zhaoliu`，**密码即账号名**（`zhangsan` / `zhangsan`）
- 服务帐号 `cn=admin,dc=example,dc=local` 接受任意非空口令
- 之后在「LDAP 与权限」页把主机填 `127.0.0.1`、端口填 `3890`，即可用域账号登录；
  也可以直接跑下面 §7 的脚本，`--mock-ldap` 会自动临时切换认证源并在结束时还原。

⚠️ mock 目录里没有真实 AD 用户，**不要**在连了真实 AD 的实例上对它做目录同步，否则真实用户会被标记为离职。

> 只想在本机验证「域账号 + 域密码」能不能登录，**用本节就够了**（账号与容器里的 `seed.ldif` 相同，
> 但**口令口径不同**，见 §5.1）。

### 5.1 容器 dev profile 的口令与 mock 不一样（别混用）

两套测试目录的**账号相同、口令口径不同**：

| 环境 | 端口 | 口令规则 | 举例 |
|---|---|---|---|
| 本地 mock（`scripts/mock-ldap-server.mjs`） | 3890 | 口令 = 账号名 | `zhangsan` / `zhangsan` |
| 容器 `--profile dev`（`docker/ldap/seed.ldif`） | 389 | `Passw0rd!` + 账号名 | `zhangsan` / `Passw0rd!zhangsan` |

`seed.ldif` 里的测试用户**已经带 `userPassword`**，不需要再补。容器里登录不上，按顺序查三条：

1. **目录卷是不是旧的**（最常见）。种子只在数据卷为空、容器**第一次**启动时导入一次；
   若卷是在文件还没有口令的年代建的，目录里就真的没这条口令，改文件也不会自动回流。先验证：

   ```powershell
   # 能 bind 通 → 目录里已有口令，什么都不用改
   docker compose --profile dev exec ldap ldapwhoami -x -D "uid=zhangsan,ou=people,dc=example,dc=local" -w "Passw0rd!zhangsan"

   # 看条目的 userPassword 属性是否真的存在（有输出即已写入）
   docker compose --profile dev exec ldap ldapsearch -x -b "dc=example,dc=local" -D "cn=admin,dc=example,dc=local" -w admin "(uid=zhangsan)" userPassword
   ```

2. **口令串有没有照抄对**：`Passw0rd!` + 账号名（大写 P、数字 0、结尾感叹号），不是账号名本身。
3. **确实要重建目录时**（第 1 条查出卷里没口令才做）：

   ```powershell
   docker compose --profile dev down
   docker volume rm transfer-approval-platform_ldap-data transfer-approval-platform_ldap-config
   docker compose --profile dev up -d
   ```

   ⚠️ 只删这两个 LDAP 卷，**不要图省事加 `-v`** —— 那会把 `platform-data`（业务数据）一起清掉。

只有**新增用户**、或手里这份 `seed.ldif` 确实缺 `userPassword` 时，才在 `dn:` 行**之后**、同一条目内补一行
（条目之间要留空行；一个条目里只能有一个 `userPassword`，重复写取值不可预期）：

```ldif
dn: uid=zhaoliu,ou=people,dc=example,dc=local
objectClass: inetOrgPerson
objectClass: posixAccount
uid: zhaoliu
userPassword: Passw0rd!zhaoliu
cn: zhaoliu
sn: 赵六
displayName: 赵六
mail: zhaoliu@example.local
uidNumber: 10004
gidNumber: 10004
homeDirectory: /home/zhaoliu
```

容器里配认证源时地址要填**服务名**而不是 `127.0.0.1`：「LDAP 与权限」页填 服务器地址 `ldap`、端口 `389`、
Base DN `dc=example,dc=local`、绑定帐号 `cn=admin,dc=example,dc=local`、绑定密码 = `.env` 里的
`LDAP_ADMIN_PASSWORD`（默认 `admin`）。

## 6. 走一遍站内收发闭环

1. 以「域账号」登录（如 `lisi`），进入 **文件发送**：选文件、多选收件人（域账号）、填发送说明、提交；
2. 命中「自动通过」规则则立即送达；否则进入 **待我审批**（切 `wangwu` 审批通过）；
3. 以收件人（如 `zhaoliu`）登录，**收件箱**里能看到「未读」→ 点下载（站内鉴权，无外链），状态变「已下载」；
4. 发送方（`lisi`）在**发送记录**里可随时**撤回**；撤回后收件人立即无法下载，送达记录 `enabled=0`；
5. **审计台账**可查看上传/审批/送达/下载/撤回全过程并导出 CSV；
6. 上传时会做**内容类型防伪装**校验（改后缀绕审批会被直接拒绝，未知类型转人工）；
   档位在「规则管理」页的「内容类型防护」可调（normal / strict / off）。

## 7. 回归脚本

| 命令 | 覆盖范围 |
|---|---|
| `node scripts/check-sha256.mjs` | 流式 SHA-256 实现与 WebCrypto 的一致性（离线） |
| `node scripts/test-ldap-login.mjs --ldap-port 3890` | 域账号登录专项：短名/邮箱登录、错误密码、缺密码、认证自检、失败锁定 |
| `node scripts/smoke-test.mjs --base http://127.0.0.1:8787 --admin zhangsan@example.local --admin-password zhangsan --approver wangwu@example.local --approver-password wangwu --requester lisi@example.local --requester-password lisi --write` | 平台接口契约（登录/可见性/规则预判/提交校验/真实提交） |
| `node scripts/e2e-internal-transfer.mjs --mock-ldap` | **站内收发闭环**：提交 → 审批前不可下载 → 审批送达 → 收件人下载（SHA-256/留痕）→ 撤回 → 下载被拒 |
| `node scripts/verify-content-type.mjs --mock-ldap` | **内容类型防伪装**：改后缀拒绝（格式不正确）、未知类型转人工、预判与提交同判、normal/strict/off 档位、流式大文件 |

不传账号时 `smoke-test.mjs` 只跑基础用例；要覆盖「高权限可见全部 / 发起人仅见本人」必须传齐三个角色账号。

> `e2e-internal-transfer.mjs`、`verify-content-type.mjs` 会**真实写入**数据（发送单/送达记录/下载事件/审计），
> 只在开发或验收环境跑。

> ⚠️ 两个易踩的小坑：
> - `test-ldap-login.mjs` **没有 `--help`**，传任何参数（包括 `--help`）都会直接开跑；它默认打
>   `127.0.0.1:3890`，运行时会**把认证源切到 mock**（联调完想连回真实 AD 需在「LDAP 与权限」页改回）。
>   它按 **mock 的口令口径**（口令 = 账号名）取密码，所以不要拿它去打容器 `--profile dev` 的目录
>   （那里是 `Passw0rd!账号名`，见 §5.1）。
> - 它最后的「失败锁定」用例会把 `zhaoliu` 锁 15 分钟（`login_attempts` 表），期间用该账号登录返回 429；
>   换 `zhangsan` / `lisi` / `wangwu` 继续即可，或等锁过期。

## 8. 数据位置与重启

- 本地数据库与文件：`%TEMP%\transfer-platform-state\`（放在 TEMP 下是为了避开项目超长路径导致 SQLite 打不开）
- 本地密钥与接口配置：`local.config.json`（不要发给他人或提交 Git）
- 迁移标记：`%TEMP%\transfer-platform-state\.transfer-platform-schema-v8`
- 清空演示/测试数据：`npm run local:reset`
- 重新构建后数据仍在：正常现象，本地数据与 `dist` 无关

## 9. 常见问题

| 现象 | 排查方向 |
|---|---|
| 启动即提示「尚未初始化本地数据库」 | 先跑 `npm run local:setup` |
| 服务在跑但接口返回 502 `upstream connect failed` | `dist` 被运行中的构建清空了；停服 → `npm run build` → 重启 |
| 登录提示「账号或密码不正确」 | 认证源指向了真实 AD 而网络不通；本地请按 §5 起 mock LDAP |
| 提交后没自动通过 | 规则里「最小大小」是**下限**：填 1MB 时小文件会落到兜底规则 `R-FALLBACK`（转人工审批） |
| 收件人看不到发送单 | 收件人必须存在于 LDAP 目录且 `active`；同步来的账号若为 DN 形式（不含 `@`）不能作为收件人 |
| 页面打不开 | 确认启动窗口仍在运行，并访问 8787 端口 |

*（内容由AI生成，仅供参考）*
