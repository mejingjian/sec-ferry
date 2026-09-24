import { IncrementalSha256 } from "@/lib/sha256";

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

type R2Like = { put: (key: string, value: ReadableStream<Uint8Array>, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }) => Promise<unknown> };

/**
 * 一边把上传字节流写进 R2，一边增量计算 SHA-256：内存里只有一个分块，占用与文件大小无关。
 * 上传路径唯一的落盘入口——原先的 request.formData() 会把整个文件读进 Worker 内存，
 * 超过约 128MB 的隔离上限就会直接崩，这是本模块存在的原因。
 *
 * R2 只接受「长度已知」的流，因此：
 * - 调用方必须提供 content-length（浏览器/Node 发送文件体时都会带）；
 * - 内部用 FixedLengthStream 把长度透传给 R2，同时顺带校验实际字节数与声明一致。
 */
export async function putStreamWithDigest(
  bucket: R2Like,
  key: string,
  source: ReadableStream<Uint8Array>,
  options: { contentType?: string; applicationId: string; lengthBytes: number; limitBytes?: number },
): Promise<{ sizeBytes: number; sha256: string }> {
  const limitBytes = options.limitBytes ?? MAX_UPLOAD_BYTES;
  if (!Number.isFinite(options.lengthBytes) || options.lengthBytes <= 0) throw new UploadLengthRequiredError();
  if (options.lengthBytes > limitBytes) throw new UploadTooLargeError(limitBytes);

  const hasher = new IncrementalSha256();
  const { readable, writable } = new FixedLengthStream(options.lengthBytes);
  // 先把消费端（R2）挂上，再开始泵数据，避免背压互等
  const uploaded = bucket.put(key, readable, {
    httpMetadata: { contentType: options.contentType || "application/octet-stream" },
    customMetadata: { applicationId: options.applicationId },
  });

  let sizeBytes = 0;
  const reader = (source as ReadableStream<Uint8Array>).getReader();
  const writer = writable.getWriter();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      sizeBytes += value.byteLength;
      hasher.update(value);
      await writer.write(value);
    }
    await writer.close();
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  await uploaded;
  return { sizeBytes, sha256: hasher.hex() };
}
