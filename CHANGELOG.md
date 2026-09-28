# 更新日志（CHANGELOG）

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

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

[1.0.0]: https://example.com/releases/tag/v1.0.0
