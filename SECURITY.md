# 安全策略（SECURITY）

本项目是一个**文件安全收发审批平台**：处理敏感文件流转、身份认证与审计留痕。安全问题的价值
取决于披露速度 —— 感谢负责任地报告。

## 支持的版本

| 版本 | 支持状态 |
|---|---|
| latest（main 分支） | ✅ 接收安全修复 |
| 其它历史 tag | ❌ 请升级 |

## 如何报告

**请不要开公开 issue 描述漏洞细节。**

1. 通过 GitHub 的「**Report a vulnerability**」（Security 标签页 → Private vulnerability reporting）
   私密报告；
2. 或发送邮件到维护者邮箱 **mejingjian@outlook.com**。

请在报告中包含：影响范围（哪个端点/流程）、复现步骤或 PoC、你的评估（严重程度）。
若涉及内网部署环境的信息请一并脱敏。

## 响应时限（尽力而为）

- **48 小时**内确认收到；
- **7 天**内给出初步评估（是否确认、严重程度）；
- 修复发布后会在 Release 说明中致谢报告人（除非你希望匿名）。

## 特别关注的范围

- 下载/可见性鉴权（`lib/visibility.ts`、`/api/files/[id]`）—— 越权读取是最严重的一类问题
- 内容类型防伪装（`lib/file-type.ts` 魔数 + `lib/content-guard.ts`）—— 后缀与内容不一致的绕过
- 会话与认证（LDAP bind 链路、登录锁定、兜底管理员）
- 加密存储（`db/crypto.mjs` 的 AES-GCM 口径）与审计哈希链（`db/audit-chain.mjs`）
- 规则引擎的匹配边界（`lib/server.ts evaluateFileDetailed()`）

## 部署方自查

漏洞不等同于配置错误。上线前请过一遍 `DOCKER-DEPLOYMENT.md` §9.4 上线验收清单，
尤其确认 `PLATFORM_ADMIN_EMAILS` 已配置（关闭兜底自声明登录）与密钥离线备份（§9.7）。
