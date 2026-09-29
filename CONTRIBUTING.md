# 贡献指南（CONTRIBUTING）

感谢关注本项目。这是一个面向**内网自托管**的文件安全收发审批平台：Next.js standalone + Node 内置
`node:sqlite` + ldapts 直连 LDAP，运行期零外部服务依赖（除目录服务本身）。

## 环境

- Node.js **≥ 22.13**（项目直接使用内置 `node:sqlite`，无需原生模块编译）
- npm（仓库锁定 `package-lock.json`，请用 `npm install` / `npm ci`）
- Windows / Linux / macOS 均可开发；**容器部署**见 `DOCKER-DEPLOYMENT.md`

## 快速上手

```bash
npm install
npm run db:migrate          # 初始化本地数据目录 .local-data/
npm run dev                 # 开发模式（http://localhost:8787）
# 或生产模式自托管：
npm run local:setup && npm run local:start    # 仅 Windows（PowerShell）
```

登录依赖 LDAP。本地联调可起 mock 目录服务（口令=账号名）：

```bash
node scripts/mock-ldap-server.mjs --port 3890
```

测试账号：`zhangsan` / `lisi` / `wangwu` / `zhaoliu`（口令即账号名）。管理员 = zhangsan。

## 提交前自查

```bash
npm run verify        # lint + typecheck + 编码约定（.ps1 必须 UTF-8 BOM + CRLF）
npm run test:rekey    # 密钥轮换回归（40 项，合成库演练，不碰真实数据）
npm run smoke         # 端到端冒烟（需要平台在跑；--mock-ldap 可自动切换认证源）
npm run e2e           # 完整业务回归（29 项）
```

CI 会跑同一套检查，PR 不绿不合并。

## 工程约定（有历史教训背书，请遵守）

- **`.ps1` 必须 UTF-8 BOM + CRLF**：历史上无 BOM+LF 的脚本中文被当 ANSI 读，Parser 直接报语法错。
  `npm run check:encoding` 会做字节级校验；`.gitattributes` 已固定 `.ps1`→CRLF、`.sh`/`.md`→LF。
- **单一真相模块**：加解密（`db/crypto.mjs`）、审计哈希链拼接（`db/audit-chain.mjs`）、迁移（`db/migrations.mjs`）
  只有一份实现，应用与 CLI 共用。改口径只改模块本身，**不要复制实现**。
- **新增加密存储字段必须同步登记** `scripts/rekey.mjs` 的 `CIPHERTEXT_TARGETS`，否则密钥轮换会漏掉它。
- sha256 一律流式计算（禁 `arrayBuffer`）；上传走 `putStreamWithDigest`。
- 可见性判断唯一入口 `lib/visibility.ts`；文件类型判定唯一入口 `lib/file-type.ts`（512B 魔数）。
- 规则引擎判定唯一入口 `lib/server.ts evaluateFileDetailed()`，preview 与提交共用。

## 提交与 PR

- 提交信息用祈使句、一行主题 + 空行后正文；一个 PR 一个主题。
- 涉及安全边界（鉴权、可见性、加密、审计链）的改动请在 PR 描述里明确列出影响面。
- 文档与代码同步改：行为变了，对应的 `README` / `DOCKER-DEPLOYMENT` / `DEVELOPMENT` 段落一并更新。

## 行为准则

参与本项目即表示同意 `CODE_OF_CONDUCT.md`。安全问题请走 `SECURITY.md` 的披露流程，**不要**开公开 issue。

## 联系方式

- 仓库：<https://github.com/mejingjian/sec-ferry>
- 缺陷与建议：[GitHub Issues](https://github.com/mejingjian/sec-ferry/issues)
- 安全漏洞：见 `SECURITY.md`（GitHub 私密漏洞报告，或邮件 mejingjian@outlook.com）
- 维护者：mejingjian
