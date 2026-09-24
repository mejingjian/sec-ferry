// 上传落盘：一边把字节流写进存储，一边增量计算 SHA-256。
//
// 与旧实现的差别：旧版依赖 Cloudflare 的 `FixedLengthStream` 把已知长度透传给 R2
// （R2 只接受定长流）。本地文件系统没有这个限制，因此这里改为：
//   把源流经一个「边过边哈希 + 计数」的 TransformStream，再交给存储实现写盘；
//   写完后校验实际字节数与 Content-Length 声明一致 —— 中途截断不会被当成成功。
//
// 内存占用依旧与文件大小无关（只保留当前分块），这是本模块存在的原因：
// 旧代码用 request.formData() 会把整个文件读进运行时内存，大文件必然崩。

import { IncrementalSha256 } from "@/lib/sha256";
import type { FileBucket } from "@/lib/storage";

// 单文件大小上限（与前端提示、路由校验保持一致）
export const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

export class UploadTooLargeError extends Error {
  constructor(limitBytes: number = MAX_UPLOAD_BYTES) {
    super(`单个文件不能超过 ${Math.floor(limitBytes / 1024 / 1024 / 1024)}GB`);
    this.name = "UploadTooLargeError";
  }
}

export class UploadLengthRequiredError extends Error {
  constructor() {
    super("上传请求缺少 Content-Length 头，无法确定文件长度");
    this.name = "UploadLengthRequiredError";
  }
}

export class UploadLengthMismatchError extends Error {
  constructor(declared: number, actual: number) {
    super(`上传数据不完整：声明 ${declared} 字节，实际收到 ${actual} 字节`);
    this.name = "UploadLengthMismatchError";
  }
}

/**
 * 把上传流写入存储并返回真实大小与摘要。
 *
 * @param bucket 存储实现（本地文件系统；接口形态与 R2 对齐，便于将来换回对象存储）
 * @param key    对象键，形如 `quarantine/<发送单号>/<安全文件名>`
 * @param source 请求体字节流
 */
export async function putStreamWithDigest(
  bucket: FileBucket,
  key: string,
  source: ReadableStream<Uint8Array>,
  options: { contentType?: string; applicationId: string; lengthBytes: number; limitBytes?: number },
): Promise<{ sizeBytes: number; sha256: string }> {
  const limitBytes = options.limitBytes ?? MAX_UPLOAD_BYTES;
  if (!Number.isFinite(options.lengthBytes) || options.lengthBytes <= 0) throw new UploadLengthRequiredError();
  if (options.lengthBytes > limitBytes) throw new UploadTooLargeError(limitBytes);

  const hasher = new IncrementalSha256();
  let sizeBytes = 0;

  // 透传 + 计数 + 哈希：不缓存整文件，只处理流经的分块
  const tap = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      sizeBytes += chunk.byteLength;
      hasher.update(chunk);
      controller.enqueue(chunk);
    },
  });

  const reader = source.getReader();
  const piped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => undefined);
    },
  });

  await bucket.put(key, piped.pipeThrough(tap), {
    contentType: options.contentType || "application/octet-stream",
    customMetadata: { applicationId: options.applicationId },
    lengthBytes: options.lengthBytes,
  });

  // 双保险：存储实现已校验过一次，这里再核对一次哈希器看到的字节数
  if (sizeBytes !== options.lengthBytes) throw new UploadLengthMismatchError(options.lengthBytes, sizeBytes);

  return { sizeBytes, sha256: hasher.hex() };
}
