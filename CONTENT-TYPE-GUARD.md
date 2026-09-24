# 内容类型防伪装方案（防止改后缀绕过审批）

> 需求提出：2026-09-22
> 状态：**已实现并回归通过（P0–P4，2026-09-22）**
> 关联模块：嗅探（`lib/file-type.ts`）、策略（`lib/content-guard.ts`）、规则引擎（`lib/server.ts`）、
> 上传接口（`app/api/applications/route.ts`）、流式上传（`lib/upload.ts`）、规则预判（`app/api/rules/preview/route.ts`）
>
> **实施结果（与原方案的关键差异以用户定稿为准）**：
> 1. **不一致一律拒绝**（不是"从严合并取更严动作"）：声明后缀 ≠ 嗅探内容类型 → 403
>    「文件格式不正确：声明后缀 .x 与实际内容类型（y）不符，已拒绝。请勿通过修改文件后缀绕过审批。」
> 2. **未知类型兜底**：normal 档转人工审批；strict 档一律拒绝；off 档仅记录不影响判定。
> 3. **开关在管理页可配**（`integration_settings.contentTypeGuard`，`PUT /api/admin/config` 支持 guardOnly 局部更新），
>    不是环境变量。
> 4. 迁移 `0009_content_guard.sql`（marker v9）：applications 增 `detected_kind / detected_extensions / type_mismatch / content_signature`；
>    同时该迁移删除了 `kind` 列与存量归档数据（「历史外发」功能整体移除）。
> 5. 实施中修复的两个坑：预判接口 `typeMismatch` 口径曾误用「识别出类型」而非「与声明不符」；
>    guard 拒绝路径对上传中的请求体 `cancel()` 会让 workerd 瞬断（下一请求 503），已改为**读完剩余请求体**。
> 6. 回归：`node scripts/verify-content-type.mjs --mock-ldap`（**26 项**，TC-01~TC-12）+ e2e 29 项 + 冒烟 26 项，全绿。

---

## 0. 人话版结论（TL;DR）

- **问题**：现在"要不要审批"完全取决于**文件名后缀**。把 `合同.pdf` 改名成 `合同.bin`，
  如果 `.bin` 恰好命中"自动通过"的规则，就**绕过了审批**直接送到收件人手里。
- **对策**：**不信后缀，看内容**。上传时顺手读文件开头的"指纹"（文件签名 / 魔数），
  和后缀对一下；不一致就**按更严格的那个走**（拒绝 > 转人工 > 自动通过），并留痕给审批人看。
- **能防住**：只改名字不改内容的规避（这是最常见、成本最低的手法，`Passw0rd` 式的小聪明）。
- **防不住**：把内容真正转码成另一种格式（例如把机密文档截图成 PNG）。那已经不是"改后缀"，
  需要 DLP / OCR / 杀毒引擎级别的手段，本方案在 §4 如实说明边界。
- **成本**：不动上传的内存模型（仍是流式、恒定内存），只是**顺便看一眼开头 512 字节**。

---

## 1. 现状与证据

### 1.1 判定链路（只认后缀）

| 环节 | 位置 | 取到的是什么 |
|---|---|---|
| 提交 | `app/api/applications/route.ts:115` | `fileName.split(".").pop()` → 纯文件名末段 |
| 落盘后的正式判定 | 同文件 `:155` | `evaluateFileDetailed(extension, sizeBytes, department)` |
| 落盘前的快速否决（拒绝类） | 同文件 `:124-127` | 同上，但此时**还没读文件内容** |
| 规则匹配本体 | `lib/server.ts:113-141` | `rule.extensions.split(",")` 与 `extension` 做字符串相等比较 |
| 前端实时预判 | `app/api/rules/preview/route.ts:16` | 同样只取文件名后缀 |

**结论**：`extension` 是**用户完全可控的输入**，规则引擎没有任何独立于文件的第二证据。

### 1.2 威胁场景

```
合同.pdf（规则：转人工审批）  →  改名  合同.bin（规则：自动通过）
                                ↓
                     规则判定 = 自动通过 → 直接送达收件人
                     审批人从头到尾没看到这份文件
```

同时它还会污染审计口径：`applications.extension` 记的是 `bin`，台账上看起来人畜无害。

### 1.3 现成的抓手

`lib/upload.ts:50-60` 的读取循环已经在**逐块搬字节**（`reader.read()` → `hasher.update` → `writer.write`）。
**第一块数据天然过手**，在那里抓前 512 字节做签名判定，是零额外 IO、零额外内存的做法。

---

## 2. 设计原则

1. **双证据**：规则匹配同时吃「声明后缀」与「内容嗅探出的候选后缀」两组输入。
2. **从严合并**：两组证据冲突时，取**更严格**的动作（`拒绝` > `转人工审批` > `自动通过`），
   绝不取"更宽松"的那个。这条是整套方案的安全底线。
3. **不误伤**：真正的 `.bin` / `.dat` / 未知格式不会被一刀切拒绝（默认策略下仍按声明后缀走），
   避免把正常业务堵死。需要更严时可切 `strict`。
4. **可复核**：判定依据（声明类型、嗅探类型、命中规则、证据字节）全部落库 + 写审计，
   审批人在页面上**一眼看到**"这文件后缀和内容对不上"。
5. **恒定内存**：不把文件读进内存，不二次读 R2（进阶的容器剖析用 R2 range 读，见 §3.7）。
6. **可回退**：给一个策略开关，出问题能立刻降级回现状（`off`）。

---

## 3. 方案设计

### 3.1 内容签名嗅探（`lib/file-type.ts`，新增）

纯函数，输入 `Uint8Array`（首 512 字节），输出类型标签：

```ts
export type SniffResult = {
  kinds: string[];        // 命中可能的类型标签，如 ["pdf"] / ["zip-container"] / ["ole2"] / []
  extensions: string[];   // 该类型可能对应的后缀集合，如 ["docx","xlsx","pptx","zip"]
  evidence: string;       // 命中依据：签名 hex，如 "255044462d"（%PDF-）
  confidence: "high" | "medium" | "low";
  category: "document" | "archive" | "image" | "executable" | "script" | "media" | "binary" | "text" | "unknown";
};
```

签名表（MVP 覆盖，均为业界公开的文件签名）：

| 类型 | 开头字节（hex / ASCII） | 候选后缀 |
|---|---|---|
| PDF | `25 50 44 46 2D` (`%PDF-`) | pdf |
| ZIP 容器 | `50 4B 03 04` (`PK\x03\x04`) | zip / docx / xlsx / pptx / jar / apk |
| OLE2（老 Office） | `D0 CF 11 E0 A1 B1 1A E1` | doc / xls / ppt / msg |
| RTF | `7B 5C 72 74 66` (`{\rtf`) | rtf / doc |
| PNG | `89 50 4E 47 0D 0A 1A 0A` | png |
| JPEG | `FF D8 FF` | jpg / jpeg |
| GIF | `47 49 46 38` (`GIF8`) | gif |
| BMP | `42 4D` (`BM`) | bmp |
| WEBP | `52 49 46 46`…`57 45 42 50` (`RIFF`+`WEBP`) | webp |
| 7z / RAR / GZIP / TAR | `37 7A BC AF 27 1C` / `52 61 72 21` / `1F 8B` / `ustar`@257 | 7z / rar / gz / tar |
| 可执行体 | `4D 5A` (`MZ`) / `7F 45 4C 46` (ELF) / Mach-O | exe / dll / so / elf |
| 脚本 | `23 21` (`#!`) / `@echo` / `<!DOCTYPE` / `<?php` | sh / bat / ps1 / php |
| SQLite | `53 51 4C 69 74 65 20 66 6F 72 6D 61 74 20 33 00` | db / sqlite |
| 纯文本启发 | 前 512 字节全部落在可打印字符/CR/LF/TAB 且含可读文本 | txt / csv / json / log / xml / md |

> 说明：`.bin` 本身**没有固定签名**，所以"后缀 .bin + 内容是 PDF"必然被判为不一致——
> 这正是本方案要抓的典型场景。

### 3.2 类型标签 → 参与规则匹配的后缀集合

```
声明后缀集合 D = { 归一化后的真实后缀 }         例：{ "bin" }
嗅探后缀集合 S = sniff.kinds 对应后缀 ∩ 平台已知后缀 例：{ "pdf" }
参与匹配集合 M = D ∪ S                         例：{ "bin", "pdf" }
```

工程实现：`evaluateFileDetailed()` 增加一个入参（`extensions: string[]`），
内部把 `extensions.includes(ext)` 改成"与 M 求交集非空"；`FALLBACK` 与 `skipped` 诊断口径同步调整。

### 3.3 从严合并判定

对 `M` 中每个后缀各跑一次判定，取 `ACTION_SEVERITY` 最高者：

```ts
const ACTION_SEVERITY = { "拒绝": 3, "转人工审批": 2, "自动通过": 1 };
```

| 场景 | 声明后缀 | 嗅探结果 | 参与匹配 | 最终动作 |
|---|---|---|---|---|
| 正常 PDF | pdf | pdf | {pdf} | 按 pdf 规则（**与现状一致**） |
| **PDF 改名 .bin** | bin | pdf | {bin, pdf} | **转人工**（pdf 规则的更严动作） |
| **docx 改名 .bin** | bin | zip-container→docx | {bin, docx} | **转人工** |
| 真 .bin 随机数据 | bin | unknown | {bin} | 按 bin 规则（**与现状一致**，不误伤） |
| .exe 改名 .txt | txt | MZ→exe | {txt, exe} | **拒绝**（若 exe 规则为拒绝） |
| **纯文本改名 .docx** | docx | text | {docx, txt} | 取 docx 与 txt 规则中更严者 |

`strict` 模式下再加一条：**只要不一致（mismatch）就直接转人工审批**，不看规则命中结果。

### 3.4 数据模型（迁移 `0009_content_type_guard.sql`，marker → v9）

`applications` 新增列（全部可空，兼容存量数据）：

| 列 | 类型 | 说明 |
|---|---|---|
| `declared_extension` | text | 声明后缀（= 现有 `extension`，新增是为了口径显式化，便于对比） |
| `detected_kind` | text | 嗅探出的类型标签，如 `pdf` / `zip-container` / `unknown` |
| `detected_extensions` | text | 嗅探出的候选后缀（逗号分隔），即"§3.2 的 S" |
| `type_mismatch` | integer(bool) | 后缀与内容是否不一致 |
| `content_signature` | text | 命中的签名 hex（≤16 字节），用于复核，**不存文件内容** |

> 现有 `extension` 列保留不动（避免破坏可见性/查询/前端），`declared_extension` 与其同值写入。

### 3.5 策略开关

`integration_settings` 加一列 `content_type_guard`（或读环境变量 `CONTENT_TYPE_GUARD`，二选一，建议跟随现有配置中心）：

| 取值 | 行为 |
|---|---|
| `normal`（默认） | 不一致 → 取更严格动作 + 审计告警（**推荐上线值**） |
| `strict` | 不一致 → 一律转人工审批 + 审计告警（高敏场景） |
| `off` | 只嗅探记录、不影响判定（回退开关） |

### 3.6 前端呈现

1. **提交页（`SubmitView.tsx`）**：选中文件后用 `file.slice(0, 512)` 在浏览器本地做同样的嗅探，
   预判面板显示三行——「文件名后缀：bin」「实际内容：PDF 文档」「结论：**不一致，将转人工审批**」，
   黄条警告。**同一套签名表**（`lib/file-type.ts` 前端可复用）避免前后端口径漂移。
2. **申请列表 / 详情（`ApplicationTable.tsx`）**：mismatch 的单子加醒目标签
   「后缀与内容不符」（如 `原 .pdf → 现 .bin`）。
3. **审批页（`ApprovalsView.tsx`）**：审批人处理前必须看到该提示 + 命中依据，避免"闭眼点通过"。
4. **审计页（`AuditView.tsx`）**：新增事件类型 `CONTENT_TYPE_MISMATCH`（result=`ALERT`）可筛可导出。

### 3.7 进阶（第二阶段，可选）

| 增强项 | 做法 | 价值 |
|---|---|---|
| Office 容器细分 | 用 R2 range 读 ZIP 中央目录，看 `word/document.xml` / `xl/workbook.xml` / `ppt/presentation.xml` | 把 `zip-container` 精确成 docx/xlsx/pptx |
| 宏文件识别 | 容器内存在 `vbaProject.bin` → 直接转人工/拒绝 | 拦宏病毒载体 |
| 加密包 | ZIP 加密标志位 / 高熵内容 → 无法判定 → 转人工 | 防止"加密后改名"绕过 |
| 文件名规范化 | 处理双扩展名（`a.pdf.bin`）、尾随空格与点、RTL 覆盖字符 `U+202E`、Unicode 同形字 | 堵住更刁钻的改名手法 |
| 内容转码检测 | 需要 DLP/OCR/杀毒引擎（ClamAV 容器 / YARA） | 应对真正的伪装内容 |

### 3.8 实现要点（踩坑提示）

- **`request.body` 只能消费一次**：需要先 `getReader()` 读第一块 → 取出前 512 字节做嗅探 →
  再用 `new ReadableStream({ start })` 把「首块 + 剩余流」拼回一个等价流交给 `putStreamWithDigest`。
  `Content-Length` 不变，落盘时的长度校验依然成立（`lib/storage.ts` 会核对实际写入字节数）。
- **"拒绝"要提前返回**：嗅探在**落盘之前**完成，命中拒绝规则时走 `failWithStream`
  （它会把请求体读完再回错误响应，保证对端拿到完整错误而不是被复位连接），省一次无谓的隔离区写入。
- **判定只做一次**：`precheck`（落盘前）与正式判定（落盘后）都要接入嗅探结果，避免两处口径不一致
  ——历史上 `lib/visibility.ts` 就吃过"两处各写一套"的亏。
- **审计哈希链只增不改**：新增事件只能 `appendAudit` 追加，不得回填历史事件（审计链的既定治理原则）。

---

## 4. 覆盖边界（能防什么 / 防不了什么）

**能防住**：
- 改后缀不改变内容（`合同.pdf` → `合同.bin`）—— 本方案的核心目标。
- 双扩展名、大小写、尾随空格等浅层伪装（配合 §3.7 的文件名规范化）。
- 用 ZIP/Office 容器包装的可执行/宏内容（配合 §3.7）。

**防不住（要如实告知）**：
- **内容真转码**：把机密文档截图成 PNG、把文本塞进图片隐写、把内容加密后改名。
  此时"后缀"与"内容"是**一致的**（它真的成了 PNG），魔数检测看不出问题，
  需要 DLP / OCR / 杀毒 / 敏感信息识别才能应对。
- **无签名的自定义格式**：`.bin` 里塞的是自家程序的私有格式，只能归为 `unknown`。
  默认策略下按声明后缀走，**不会**自动升级为转人工（需 `strict` 模式）。

**因此**：本方案是"抬高规避门槛"，不是"消灭规避"。**规则配置本身仍是最后一道闸门**——
高敏内容不应配"自动通过"规则，这条要在使用规范里写明。

---

## 5. 验收用例（回归清单）

| 用例 | 输入 | 期望 |
|---|---|---|
| TC-01 | 真 PDF，后缀 `.pdf` | 按 pdf 规则判定，`type_mismatch=0`，**与现状完全一致** |
| TC-02 | PDF 内容，后缀改成 `.bin` | 判定取 `{bin, pdf}` 的更严动作（本例：转人工）；`type_mismatch=1`；审计有 `CONTENT_TYPE_MISMATCH` |
| TC-03 | docx（ZIP 容器）内容，后缀 `.bin` | 同上，`detected_kind=zip-container`，候选后缀含 docx |
| TC-04 | 真 `.bin`（随机字节） | `detected_kind=unknown`，按声明后缀判定，**不误伤** |
| TC-05 | `.exe`(MZ) 内容，后缀 `.txt` | 若 exe 规则为拒绝 → 拒绝，`type_mismatch=1` |
| TC-06 | 纯文本内容，后缀 `.docx` | `type_mismatch=1`，取更严动作 |
| TC-07 | 双扩展名 `报表.pdf.bin` | 真实末段 = `bin`，内容 = pdf → 判为不一致并从严 |
| TC-08 | 预判接口（`/api/rules/preview`）与真实提交 | 两者结论**必须一致**（同一引擎、同一签名表） |
| TC-09 | `CONTENT_TYPE_GUARD=strict` | 任何不一致直接转人工，即使规则是自动通过 |
| TC-10 | `CONTENT_TYPE_GUARD=off` | 判定回落到"只看后缀"（与当前版本行为一致），但仍记录嗅探结果 |
| TC-11 | 大文件（≥1GB 上限内） | 嗅探不影响流式上传，内存占用不随文件大小增长 |
| TC-12 | 老数据（0009 之前的发送单） | 新列可空、页面不报错、列表正常渲染 |

> 建议落成脚本 `scripts/verify-content-type.mjs`（与 `verify-archive.mjs` 同风格：自造样本 + 断言 + 摘要输出），
> 便于上线前一把跑完。

---

## 6. 实施顺序建议

| 阶段 | 内容 | 依赖 |
|---|---|---|
| P0 | `lib/file-type.ts` 签名表 + 单测脚本（离线，不碰业务） | 无 |
| P1 | 上传接口接入嗅探（流重组 + 提前拒绝）+ `evaluateFileDetailed` 支持多后缀 + 从严合并 | P0 |
| P2 | 迁移 `0009` + 落库新列 + 审计事件 + 预判接口对齐 | P1 |
| P3 | 前端三处呈现（提交页预判 / 列表标签 / 审批页提示）+ 策略开关 | P2 |
| P4 | 回归脚本 `verify-content-type.mjs`（TC-01~TC-12）+ 文档更新（`LOCAL/PROD-DEPLOYMENT` 变量矩阵） | P3 |
| P5 | 进阶：容器剖析、宏识别、文件名规范化 | P4 |

---

## 7. 待确认事项

1. 默认策略取 `normal`（从严合并）还是 `strict`（不一致一律转人工）？
2. 是否需要"**未知类型也强制转人工**"的兜底（对 `.bin` 类文件更严，但可能误伤正常业务）？
3. 策略开关放**管理页面可配**（`integration_settings`）还是**环境变量**（部署时定死）？
4. 是否在 P0 之后立即实现 P1–P3（即本轮就做）？

---

*（方案由 AI 生成，供评审参考）*
