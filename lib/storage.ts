// 文件存储：本地文件系统实现的「对象桶」，替代原先的 Cloudflare R2 绑定。
//
// 局域网自托管场景不需要对象存储 —— 隔离区文件就是一堆按 objectKey 落盘的普通文件，
// 备份 = 复制目录，排查 = 直接看文件。因此这里保留 R2 的最小接口形态，让上层零改动：
//
//   put(key, stream, options)  → 流式写盘（先写临时文件再原子改名）
//   get(key)                   → { body, writeHttpMetadata(headers) }
//   delete(key)                → 删除对象及其元数据
//   list({ prefix })           → 遍历（清理任务与运维排查用）
//
// 安全：key 全部来自服务端生成（`quarantine/<发送单号>/<安全文件名>`），但仍做一次
// 归一化 + 前缀校验，防止 `..` 之类的路径穿越把文件写到数据目录之外。

import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { filesDir } from "@/lib/paths";

export type PutOptions = {
  contentType?: string;
  customMetadata?: Record<string, string>;
  /** 调用方声明的字节数；落盘后用于校验实际写入长度是否一致 */
  lengthBytes?: number;
};

export type StoredObject = {
  key: string;
  size: number;
  body: ReadableStream<Uint8Array>;
  /** 与 R2 同名方法，便于下载路由复用 */
  writeHttpMetadata(headers: Headers): void;
};

export type ListEntry = { key: string; size: number; uploaded: Date };

export type FileBucket = {
  put(key: string, value: ReadableStream<Uint8Array>, options?: PutOptions): Promise<{ key: string; size: number }>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; limit?: number }): Promise<ListEntry[]>;
  head(key: string): Promise<{ key: string; size: number } | null>;
};

/** 元数据sidecar 后缀：与对象文件同目录，记录 content-type 等 R2 httpMetadata 的等价信息 */
const META_SUFFIX = ".meta.json";

function resolveKey(key: string): string {
  const root = filesDir();
  const normalized = path.posix.normalize(String(key).replace(/\\/g, "/")).replace(/^\/+/, "");
  if (!normalized || normalized.startsWith("..") || normalized.includes("../")) {
    throw new Error(`非法的对象键：${key}`);
  }
  const absolute = path.resolve(root, normalized);
  const rootWithSep = path.resolve(root) + path.sep;
  if (!absolute.startsWith(rootWithSep)) throw new Error(`非法的对象键（越出数据目录）：${key}`);
  return absolute;
}

function toWebStream(file: string, start = 0): ReadableStream<Uint8Array> {
  const nodeStream = createReadStream(file, { start });
  return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
}

export function createFileBucket(): FileBucket {
  const root = filesDir();

  return {
    async put(key, value, options = {}) {
      const target = resolveKey(key);
      mkdirSync(path.dirname(target), { recursive: true });
      // 先写临时文件再改名：中途失败不会留下一个「看起来已存在但内容不全」的对象
      const temp = `${target}.upload-${process.pid}-${Date.now()}`;
      const counter = new ByteCounter();
      try {
        await pipeline(Readable.fromWeb(value as never), counter, createWriteStream(temp));
      } catch (error) {
        rmSync(temp, { force: true });
        throw error;
      }
      const size = counter.bytes;
      if (typeof options.lengthBytes === "number" && Number.isFinite(options.lengthBytes) && size !== options.lengthBytes) {
        rmSync(temp, { force: true });
        throw new Error(`上传字节数与声明长度不一致（声明 ${options.lengthBytes}，实际 ${size}）`);
      }
      if (existsSync(target)) rmSync(target, { force: true });
      renameSync(temp, target);
      writeFileSync(
        `${target}${META_SUFFIX}`,
        JSON.stringify({
          contentType: options.contentType || "application/octet-stream",
          customMetadata: options.customMetadata || {},
          size,
          storedAt: new Date().toISOString(),
        }),
      );
      return { key, size };
    },

    async get(key) {
      const target = resolveKey(key);
      if (!existsSync(target)) return null;
      const info = statSync(target);
      let contentType = "application/octet-stream";
      try {
        const meta = JSON.parse(readFileSync(`${target}${META_SUFFIX}`, "utf8")) as { contentType?: string };
        if (meta.contentType) contentType = meta.contentType;
      } catch {
        // 元数据缺失（手工放进来的文件）时退回二进制流
      }
      return {
        key,
        size: info.size,
        body: toWebStream(target),
        writeHttpMetadata(headers: Headers) {
          headers.set("content-type", contentType);
          headers.set("content-length", String(info.size));
        },
      };
    },

    async head(key) {
      const target = resolveKey(key);
      if (!existsSync(target)) return null;
      return { key, size: statSync(target).size };
    },

    async delete(key) {
      const target = resolveKey(key);
      rmSync(target, { force: true });
      rmSync(`${target}${META_SUFFIX}`, { force: true });
    },

    async list(options = {}) {
      const prefix = (options.prefix || "").replace(/\\/g, "/");
      const limit = options.limit ?? 1000;
      const entries: ListEntry[] = [];
      const walk = (dir: string) => {
        if (entries.length >= limit) return;
        for (const item of readdirSync(dir, { withFileTypes: true })) {
          if (entries.length >= limit) return;
          if (item.name.endsWith(META_SUFFIX)) continue;
          const absolute = path.join(dir, item.name);
          if (item.isDirectory()) {
            walk(absolute);
            continue;
          }
          const relative = path.relative(root, absolute).split(path.sep).join("/");
          if (prefix && !relative.startsWith(prefix)) continue;
          const info = statSync(absolute);
          entries.push({ key: relative, size: info.size, uploaded: info.mtime });
        }
      };
      if (!existsSync(root)) return entries;
      walk(root);
      return entries;
    },
  };
}

// ---------- 内部小工具 ----------

/**
 * 计数透传：Node Transform，只统计流过的字节数，不改动数据。
 * ⚠️ 必须用 Node 的 Transform 而不是 Web 的 WritableStream —— `stream.pipeline` 只接受
 * Node 流或 Web 的 Readable/Transform，传入 Web WritableStream 会直接抛 TypeError。
 */
class ByteCounter extends Transform {
  bytes = 0;

  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: unknown) => void) {
    this.bytes += chunk.length;
    callback(null, chunk);
  }
}
