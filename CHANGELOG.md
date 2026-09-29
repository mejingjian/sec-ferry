# 更新日志（CHANGELOG）

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 新增

- **CI 覆盖补齐**（此前专项回归只能本地手工敲，开源后无人会敲）：
  - `check:sha256`、`test:bootstrap` 进「静态检查与构建」作业（都不需要平台）。
  - `smoke-test` / `verify-content-type` / `test-mail-notify` / `test-ldap-login` 由新增的
    `scripts/ci-regressions.sh` 在「端到端回归」作业里一次跑完并汇总；结论以 `::notice` /
    `::error` 注解输出（步骤日志与 Job Summary 都需要登录，注解匿名可读）。
- `scripts/test-bootstrap.mjs`（`npm run test:bootstrap`）：首次部署引导的自动化回归，57 项 ——
  计划解析与默认值、口令文件、dry-run 不写库、bind 失败不写库、bind 成功回读校验、
  覆盖已有认证源、`--skip-verify`、锁死顺序陷阱、缺密钥 / 缺库。
  自带临时空库与同进程 mock LDAP，不需要平台、不碰真实数据。
- `scripts/seed-mock-env.mjs`（`npm run mock:prepare`）：联调环境准备 —— 认证源指向 mock LDAP、
  写入「管理员 / 审批人 / 发起人」三个角色、可选 `--sync` 同步目录；幂等，供手工回归与 CI 共用。
- `scripts/ci-regressions.sh`（`npm run regress`）：一次跑完平台侧五套回归并汇总，
  执行顺序固定（`test-ldap-login` 的锁定用例会把账号锁 15 分钟，必须最后）。
- `smoke-test.mjs` 与 `test-mail-notify.mjs` 支持 `--mock-ldap`：口令取账号名，
  与 e2e / verify-content-type 同一口径，不必逐个角色传口令。
- `mock-ldap-server.mjs` 支持 `MOCK_LDAP_PORT` 环境变量并导出 server 实例，
  便于测试脚本在同一进程内拉起 mock 目录（不派生子进程）。

### 修复

- `bootstrap`：读取「库里是否已有可用认证源」时用错了列名口径（原生 SQLite 行对象是
  snake_case `ldap_host` / `encrypted_secret`，原实现按 camelCase 读，恒为 undefined）——
  后果是**已配好认证源的实例被锁死陷阱检测误伤**（只想补一个角色也会被拒绝），
  覆盖留痕（审计 detail 标注「覆盖原配置」）也会丢失。由新增的 bootstrap 回归发现并修复。
- `test-mail-notify`：`--mock-ldap` 时把 mock SMTP 的应用侧地址默认切到 `127.0.0.1`
  （原先固定默认 `host.docker.internal`，本地与 CI 直连会连不上）。

### 变更

- CI：`actions/checkout` / `actions/setup-node` 升到 `@v5`（Node 20 已从 GitHub runner 移除，
  原先被强制跑在 Node 24 上并持续告警）；runner 从 `ubuntu-latest` 钉到 `ubuntu-24.04`
  （`latest` 将于 2026-10-19 迁移到 Ubuntu 26）。

## [1.0.0] - 2026-09-28

首个开源版本。此前为内部项目，本版本起以 MIT 许可发布。

### 新增

- 文件安全收发与审批流：提交 → 规则引擎自动判定 → 自动送达或转人工审批 → 逐收件人生成送达记录
- 规则引擎：按扩展名/大小等条件自动通过、转人工、拒绝；优先级匹配；提交前实时预览（preview 与提交共用同一判定入口）
- 内容类型防伪装：512 字节魔数检测 + 策略开关（normal / strict / off），后缀与内容不一致可拒绝
- 审计日志：全量操作审计，SHA-256 哈希链防篡改
- 身份认证：LDAP 直连（两步 bind、分页搜索、防枚举）、登录失败锁定、可配置管理员名单
- 角色体系：管理员 / 审批人 / 审计员 / 发起人
- 运维工具链（`scripts/`，应用与 CLI 共用单一真相模块）：
  - `preflight` 启动自检（fail-fast；只读根容器下用真实写探针判定）
  - `rekey` 密钥轮换（单事务重加密、写前校验快照、提交后复核、审计同事务；`--fingerprint` 密钥指纹比对）
  - `backup` 备份（SQLite 在线备份 API + 产物强制校验 + 空产物清扫；compose sidecar 周期执行）
  - `bootstrap` 首次部署引导（环境变量驱动、dry-run 默认、写前真实 bind 验证）
  - `reset-admin` break-glass 应急入口
- 内网 SMTP 邮件通知（零依赖手写客户端）：审批待办 / 送达通知，队列 + 重试，不阻断主流程
- 容器化：三阶段镜像、运行期零安装、只读根 + cap_drop + no-new-privileges 加固、备份 sidecar
- 本地一键脚本（Windows PowerShell）与 mock LDAP 联调目录
- 回归脚本集（冒烟 / e2e / 内容类型 / 登录 / SHA-256 / 邮件 / rekey，共 150+ 用例）与 GitHub Actions CI

### 文档

- `README` / `DOCKER-DEPLOYMENT` / `PROD-DEPLOYMENT` / `DEVELOPMENT` / `LOCAL-DEPLOYMENT`：覆盖部署、加固、排障、密钥轮换与离线备份、锁死恢复（break-glass）

[1.0.0]: https://github.com/mejingjian/sec-ferry/releases/tag/v1.0.0
