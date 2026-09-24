// 内容类型嗅探（内容防伪装，方案见 CONTENT-TYPE-GUARD.md）
// 纯函数、零依赖：输入文件首部字节（≤512 字节足够），输出命中的类型标签与候选后缀。
// 前端（提交页预判）与后端（提交/预判接口）共用同一张签名表，保证口径一致。

export type SniffResult = {
  /** 命中的类型标签，如 ["pdf"] / ["zip-container"]；空数组 = 未知类型 */
  kinds: string[];
  /** 类型可能对应的后缀集合，如 ["pdf"] / ["docx","xlsx","pptx","zip"] */
  extensions: string[];
  /** 命中依据：签名 hex（≤16 字节），仅用于复核留痕，不含文件内容 */
  evidence: string;
  category: "document" | "archive" | "image" | "executable" | "script" | "media" | "binary" | "text" | "unknown";
};

function hex(bytes: Uint8Array, length: number): string {
  return Array.from(bytes.slice(0, length), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function startsWith(bytes: Uint8Array, signature: number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function asciiStartsWith(bytes: Uint8Array, text: string, offset = 0): boolean {
  return startsWith(bytes, Array.from(text, (char) => char.charCodeAt(0)), offset);
}

/** 可打印 ASCII / CR / LF / TAB 占比启发：全部命中且含可读文本 → 视为纯文本 */
function looksLikeText(bytes: Uint8Array): boolean {
  if (!bytes.length) return false;
  let printable = 0;
  for (const byte of bytes) {
    if ((byte >= 0x20 && byte <= 0x7e) || byte === 0x0d || byte === 0x0a || byte === 0x09) printable += 1;
  }
  return printable === bytes.length;
}

const SIGNATURE_TABLE: Array<{ kind: string; category: SniffResult["category"]; extensions: string[]; match: (bytes: Uint8Array) => boolean }> = [
  { kind: "pdf", category: "document", extensions: ["pdf"], match: (b) => asciiStartsWith(b, "%PDF-") },
  { kind: "zip-container", category: "archive", extensions: ["zip", "docx", "xlsx", "pptx", "jar", "apk"], match: (b) => startsWith(b, [0x50, 0x4b, 0x03, 0x04]) || startsWith(b, [0x50, 0x4b, 0x05, 0x06]) || startsWith(b, [0x50, 0x4b, 0x07, 0x08]) },
  { kind: "ole2", category: "document", extensions: ["doc", "xls", "ppt", "msg"], match: (b) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]) },
  { kind: "rtf", category: "document", extensions: ["rtf", "doc"], match: (b) => asciiStartsWith(b, "{\\rtf") },
  { kind: "png", category: "image", extensions: ["png"], match: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  { kind: "jpeg", category: "image", extensions: ["jpg", "jpeg"], match: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  { kind: "gif", category: "image", extensions: ["gif"], match: (b) => asciiStartsWith(b, "GIF8") },
  { kind: "bmp", category: "image", extensions: ["bmp"], match: (b) => startsWith(b, [0x42, 0x4d]) },
  { kind: "webp", category: "image", extensions: ["webp"], match: (b) => asciiStartsWith(b, "RIFF") && asciiStartsWith(b, "WEBP", 8) },
  { kind: "7z", category: "archive", extensions: ["7z"], match: (b) => startsWith(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) },
  { kind: "rar", category: "archive", extensions: ["rar"], match: (b) => asciiStartsWith(b, "Rar!") },
  { kind: "gzip", category: "archive", extensions: ["gz"], match: (b) => startsWith(b, [0x1f, 0x8b]) },
  { kind: "tar", category: "archive", extensions: ["tar"], match: (b) => asciiStartsWith(b, "ustar", 257) },
  { kind: "executable", category: "executable", extensions: ["exe", "dll", "so", "elf"], match: (b) => asciiStartsWith(b, "MZ") || startsWith(b, [0x7f, 0x45, 0x4c, 0x46]) },
  { kind: "script", category: "script", extensions: ["sh", "bat", "ps1", "php"], match: (b) => asciiStartsWith(b, "#!") || asciiStartsWith(b, "@echo") || asciiStartsWith(b, "<?php") || asciiStartsWith(b, "<!DOCTYPE") },
  { kind: "sqlite", category: "binary", extensions: ["db", "sqlite"], match: (b) => asciiStartsWith(b, "SQLite format 3\u0000") },
];

/**
 * 嗅探文件类型。无签名可识别时：
 * - 纯文本 → kinds=["text"]（txt/csv/json 等都是文本，不算未知）
 * - 否则 → kinds=[]（unknown），由策略层决定处置（normal 转人工 / strict 拒绝）
 */
export function sniffFileType(head: Uint8Array): SniffResult {
  const bytes = head instanceof Uint8Array ? head : new Uint8Array(head);
  const hits = SIGNATURE_TABLE.filter((entry) => entry.match(bytes));
  if (hits.length) {
    const kinds = hits.map((entry) => entry.kind);
    const extensions = Array.from(new Set(hits.flatMap((entry) => entry.extensions)));
    const evidence = hex(bytes, 16);
    return { kinds, extensions, evidence, category: hits[0].category };
  }
  if (looksLikeText(bytes)) {
    return { kinds: ["text"], extensions: ["txt", "csv", "json", "log", "xml", "md"], evidence: hex(bytes, 8), category: "text" };
  }
  return { kinds: [], extensions: [], evidence: hex(bytes, 8), category: "unknown" };
}

/**
 * 声明后缀与嗅探结果是否不一致：
 * - 嗅探为 unknown（无签名、非文本）→ 不算不一致（无法证明），交由策略的「未知类型」分支处置
 * - 嗅探命中，且声明后缀 ∉ 候选后缀集合 → 不一致（如 .bin 装着 PDF、.txt 装着 MZ）
 * 注意 ZIP 容器候选含 docx/xlsx/pptx/zip 等，声明其中任意一个都算一致（容器细分属第二阶段）。
 */
export function isTypeMismatch(declaredExtension: string, sniff: SniffResult): boolean {
  if (!sniff.kinds.length) return false;
  const declared = declaredExtension.trim().toLowerCase().replace(/^\.+/, "");
  if (!declared) return true;
  return !sniff.extensions.includes(declared);
}
