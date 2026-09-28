// 配置密文的加解密（纯 ESM）：应用与 CLI 共用的**唯一**一份实现。
//
// 为什么单独抽出来：此前这套 AES-GCM 逻辑在仓库里存在三份拷贝 ——
//   * lib/ldap-config.ts                                （解密 LDAP 绑定口令）
//   * app/api/admin/config/route.ts                      （加密 LDAP 绑定口令）
//   * app/api/admin/mail-config/route.ts                 （加密 SMTP 口令）
// 三份「看起来一样」的加密代码是一种隐性负债：任何一处微调（换个派生方式、换 IV 长度、
// 换字段分隔符）都会让另一处存下的密文解不开，而症状要到使用者重新保存配置时才暴露。
// 更关键的是密钥轮换工具必须与运行期**逐字节一致**，否则轮换完的库平台读不了。
// 因此收敛到本文件：改口径只改这里。
//
// 密文格式（HTTP 传输与落库都用这个形态）：
//   <ivHex>.<dataHex>
//   iv   12 字节（AES-GCM 推荐长度）→ 24 个 hex 字符
//   data 密文 + 16 字节 GCM 认证标签
// 例：明文 "admin"（5 字节）→ 24 + 1 + (5+16)*2 = 67 字符。
//
// 密钥派生：SHA-256(CONFIG_ENCRYPTION_KEY) 取 32 字节作为 AES-256-GCM 密钥。
//   注意这是「派生」而非「直接用」—— 因此密钥字符串的长度与格式不受 AES 限制，
//   但长度仍应 >= 32 字符（见 scripts/preflight.mjs 的校验）。
//
// ⚠️ 认证标签（GCM tag）在这里是**内容防篡改**的核心：密钥不对或密文被改动，
//    decrypt 会抛 OperationError 而不是解出乱码，所以「能不能解开」是可靠的判据。

const IV_BYTES = 12;

/**
 * @param {string} hex
 * @returns {Uint8Array}
 */
function fromHex(hex) {
  if (typeof hex !== "string" || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error("密文格式不正确（非十六进制）");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function toHex(bytes) {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * 由密钥串派生 AES-256-GCM 的 CryptoKey。
 * @param {unknown} key 密钥原文（通常来自 CONFIG_ENCRYPTION_KEY）
 * @param {"encrypt" | "decrypt"} usage
 * @returns {Promise<CryptoKey>}
 */
async function deriveKey(key, usage) {
  const normalized = String(key ?? "").trim();
  if (!normalized) throw new Error("服务端加密密钥不可用（CONFIG_ENCRYPTION_KEY 未配置）");
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [usage]);
}

/**
 * 加密一段明文（每次调用使用新的随机 IV，因此同一明文两次加密的密文不同）。
 * @param {string} plaintext
 * @param {unknown} key
 * @returns {Promise<string>} `<ivHex>.<dataHex>`
 */
export async function encryptSecret(plaintext, key) {
  const cryptoKey = await deriveKey(key, "encrypt");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, new TextEncoder().encode(String(plaintext)));
  return `${toHex(iv)}.${toHex(new Uint8Array(data))}`;
}

/**
 * 解密。密钥不对 / 密文被改动 / 格式不合法都会抛异常（不会静默返回乱码）。
 * @param {string} ciphertext
 * @param {unknown} key
 * @returns {Promise<string>}
 */
export async function decryptSecret(ciphertext, key) {
  const result = await tryDecryptSecret(ciphertext, key);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

/**
 * 解密但**不抛异常**，把失败原因作为返回值 —— 轮换工具需要「逐条判定能否解开」
 * 而不是在第一个失败的字段上中断。
 * @param {string} ciphertext
 * @param {unknown} key
 * @returns {Promise<{ ok: true, value: string } | { ok: false, error: string }>}
 */
export async function tryDecryptSecret(ciphertext, key) {
  if (typeof ciphertext !== "string" || !ciphertext) return { ok: false, error: "密文为空" };
  const parts = ciphertext.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, error: "密文格式不正确（应为 ivHex.dataHex）" };
  }
  try {
    const cryptoKey = await deriveKey(key, "decrypt");
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromHex(parts[0]) },
      cryptoKey,
      fromHex(parts[1]),
    );
    return { ok: true, value: new TextDecoder().decode(plain) };
  } catch (error) {
    const name = (error && /** @type {Error} */ (error).name) || "";
    if (name === "OperationError") {
      // WebCrypto 在密钥不匹配与密文被篡改时都给 OperationError —— 这正是我们要的语义
      return { ok: false, error: "解密失败：密钥不匹配或密文已损坏" };
    }
    return { ok: false, error: `解密失败：${(error && /** @type {Error} */ (error).message) || error}` };
  }
}

/**
 * 判断一个值是否「长得像本方案的密文」。
 * 用于在轮换时扫描全库，发现**没有登记在册**的密文字段时告警 —— 漏掉一处就等于轮换后锁死。
 * @param {unknown} value
 * @returns {boolean}
 */
export function looksLikeCiphertext(value) {
  return typeof value === "string" && /^[0-9a-f]{24}\.[0-9a-f]{8,}$/i.test(value);
}

/** 本方案密文的字段分隔符与 IV 长度，供轮换工具与文档引用。 */
export const CIPHERTEXT_FORMAT = { separator: ".", ivHexLength: IV_BYTES * 2 };
