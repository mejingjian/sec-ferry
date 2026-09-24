import { desc, eq, inArray } from "drizzle-orm";
import { getDb } from "@/db";
import { applications, applicationRecipients, downloadDeliveries, ldapUsers } from "@/db/schema";
import { APPLICATION_STATUS, actorFrom, appendAudit, evaluateFileDetailed, jsonError, parseApproverEmails, roleFor, runDeliveryPipeline, storage } from "@/lib/server";
import { MAX_UPLOAD_BYTES, UploadLengthRequiredError, UploadTooLargeError, putStreamWithDigest } from "@/lib/upload";
import { isTypeMismatch, sniffFileType } from "@/lib/file-type";
import { applyContentGuard, getContentTypeGuard } from "@/lib/content-guard";
import { visibleApplications } from "@/lib/visibility";
import { dispatchMailOutbox, fallbackApproverEmails, notifyApprovalPending } from "@/lib/mail";

// 送达信息：按发送单聚合（新模型每个收件人一条记录）。
// 只取「本次可见发送单」的送达记录：避免把他人发送单的收件人与下载留痕一并返回。
async function withDeliveries(db: ReturnType<typeof getDb>, rows: Array<typeof applications.$inferSelect>) {
  const ids = rows.map((row) => row.id);
  const deliveries = ids.length
    ? await db.select().from(downloadDeliveries).where(inArray(downloadDeliveries.applicationId, ids))
    : [];
  const byApplication = new Map<string, Array<typeof downloadDeliveries.$inferSelect>>();
  for (const delivery of deliveries) {
    const list = byApplication.get(delivery.applicationId) || [];
    list.push(delivery);
    byApplication.set(delivery.applicationId, list);
  }
  return rows.map((row) => ({ ...row, deliveries: byApplication.get(row.id) || [] }));
}

// 提前返回时必须处理掉请求体：未读完的字节会让运行时把 worker 重启（实测表现为紧随其后的
// 一个请求报 503 worker restarted mid-request，再下一个才恢复）。
// 小体积请求体直接读干，连接可以继续复用；大体积请求体只能取消，连接随之中断——这是预期的，
// 客户端会拿到错误响应并自行换连接重试。
async function discardBody(request: Request, keepAliveLimit = 1024 * 1024) {
  const body = request.body;
  if (!body || body.locked) return;
  const declared = Number(request.headers.get("content-length") || "0");
  const reader = body.getReader();
  try {
    if (Number.isFinite(declared) && declared > keepAliveLimit) {
      await reader.cancel().catch(() => undefined);
      return;
    }
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch {
    // 连接已中断，无需处理
  } finally {
    try { reader.releaseLock(); } catch { /* 已释放 */ }
  }
}

// 上传接口的所有错误返回统一走这里，保证请求体被妥善处理后再回响应
async function fail(request: Request, message: string, status = 400) {
  await discardBody(request);
  return jsonError(message, status);
}

// 请求体已被部分消费（嗅探缓冲）时的错误返回：把剩余请求体读完（而非 cancel），
// workerd 下对上传中的请求体执行 cancel 会让 worker 瞬断，紧随其后的请求会拿到 503。
async function failWithStream(stream: ReadableStream<Uint8Array>, message: string, status = 400) {
  try {
    await stream.pipeTo(new WritableStream({ write() {} }), { preventCancel: true });
  } catch {
    // 客户端已中断连接等情况，忽略
  }
  return jsonError(message, status);
}

// 从请求体前部缓冲最多 maxBytes 字节用于内容嗅探，并把「前缀 + 剩余流」拼回一个等价流。
// 字节逐一原样重放，Content-Length 校验（FixedLengthStream）依然成立。
async function bufferPrefix(source: ReadableStream<Uint8Array>, maxBytes = 512): Promise<{ head: Uint8Array; stream: ReadableStream<Uint8Array> }> {
  const reader = source.getReader();
  const chunks: Uint8Array[] = [];
  let collected = 0;
  try {
    while (collected < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      chunks.push(value);
      collected += value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
  const head = new Uint8Array(Math.min(collected, maxBytes));
  let offset = 0;
  let remaining = head.length;
  const buffered: Uint8Array[] = [];
  for (const chunk of chunks) {
    if (remaining <= 0) { buffered.push(chunk); continue; }
    if (chunk.byteLength <= remaining) {
      head.set(chunk, offset);
      offset += chunk.byteLength;
      remaining -= chunk.byteLength;
    } else {
      head.set(chunk.subarray(0, remaining), offset);
      buffered.push(chunk.subarray(remaining));
      remaining = 0;
    }
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (head.length) controller.enqueue(head);
      for (const chunk of buffered) controller.enqueue(chunk);
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      return reader.cancel(reason).catch(() => undefined);
    },
  });
  return { head, stream };
}

export async function GET(request: Request) {
  try {
    const identity = await roleFor(request);
    if (identity.role === "未登录" || !identity.actor) return jsonError("请先登录", 401);
    const db = getDb();
    // 0009 起历史外发归档功能已整体下线，库中只有站内发送单
    const rows = await db.select().from(applications).orderBy(desc(applications.createdAt)).limit(200);
    // 「发给我的」口径：收件人即使只是发起人角色也能看到发给自己的发送单
    const mine = new Set(
      (await db.select({ applicationId: applicationRecipients.applicationId }).from(applicationRecipients).where(eq(applicationRecipients.email, identity.actor.email?.toLowerCase() || "\u0000"))).map((item) => item.applicationId),
    );
    return Response.json(await withDeliveries(db, visibleApplications(rows, identity.actor, identity.role, mine)));
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "无法读取发送单", 500);
  }
}

export async function POST(request: Request) {
  try {
    // 上传体必须是文件的原始字节流（文件名/收件人/说明走查询参数），由 putStreamWithDigest
    // 边写 R2 边算摘要，内存占用与文件大小无关。
    // 不再接受 multipart/form-data：request.formData() 会先把整个文件读进 Worker 内存
    // （隔离上限约 128MB），大文件必然崩。
    if ((request.headers.get("content-type") || "").startsWith("multipart/form-data")) {
      return fail(request, "上传方式已更新：请把文件原始字节作为请求体，文件名、收件人、说明放入查询参数", 415);
    }
    const params = new URL(request.url).searchParams;
    const fileName = (params.get("fileName") || "").trim();
    const recipientsParam = (params.get("recipients") || params.get("recipientId") || "").trim();
    const description = (params.get("description") || "").trim();
    if (!fileName) return fail(request, "请选择需要发送的文件");
    if (!recipientsParam) return fail(request, "请选择收件人");
    if (!description) return fail(request, "请填写发送说明");
    if (!request.body) return jsonError("请选择需要发送的文件");

    // 流式直传需要长度已知：R2 只接受定长流，且长度由调用方声明后再与实际字节数核对
    const rawLength = request.headers.get("content-length");
    if (rawLength === null) return fail(request, "上传请求缺少 Content-Length 头，无法确定文件长度", 411);
    const declared = Number(rawLength);
    if (!Number.isFinite(declared) || declared < 0) return fail(request, "上传请求的 Content-Length 无效", 411);
    if (declared === 0) return fail(request, "文件内容为空（0 字节），请选择有内容的文件后再提交");
    if (declared > MAX_UPLOAD_BYTES) return fail(request, "单个文件不能超过 1GB", 413);

    const db = getDb();
    // 收件人 = 站内域账号（LDAP 目录）。逗号分隔多选，去重后逐一校验目录中存在且在职。
    const emails = Array.from(new Set(recipientsParam.split(/[,，;；\s]+/).map((email) => email.trim().toLowerCase()).filter((email) => email.includes("@"))));
    if (!emails.length) return fail(request, "收件人必须为有效的域账号邮箱");
    if (emails.length > 50) return fail(request, "单次发送收件人不能超过 50 位");
    const directory = await db.select().from(ldapUsers).where(eq(ldapUsers.active, true));
    const recipientRows = emails
      .map((email) => directory.find((user) => user.email.toLowerCase() === email))
      .filter((user): user is (typeof directory)[number] => Boolean(user));
    if (recipientRows.length !== emails.length) {
      const missing = emails.filter((email) => !recipientRows.some((user) => user.email.toLowerCase() === email));
      return fail(request, `以下收件人不在 LDAP 通讯录中或已停用：${missing.join("、")}`, 422);
    }
    const firstRecipient = recipientRows[0];
    if (!firstRecipient) return fail(request, "收件人必须为有效的域账号邮箱");

    const extension = fileName.includes(".") ? fileName.split(".").pop()!.toLowerCase() : "";
    const actor = await actorFrom(request);
    if (!actor) return fail(request, "请先登录", 401);

    // 优先从 LDAP 同步的用户目录反查发起人部门，作为规则 scope 判定依据
    const profile = actor.email ? (await db.select().from(ldapUsers).where(eq(ldapUsers.email, actor.email.toLowerCase())).limit(1))[0] : undefined;
    const department = profile?.department || "待 LDAP 同步";

    // 内容防伪装：缓冲前 512 字节做魔数嗅探，与声明后缀比对。此步在写 R2 之前完成，
    // 命中拒绝类结论时不落盘、省一次无谓的隔离区写入。
    const now = new Date().toISOString();
    const id = `SND-${now.slice(0, 10).replaceAll("-", "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    let head: Uint8Array;
    let bodyStream: ReadableStream<Uint8Array>;
    try {
      ({ head, stream: bodyStream } = await bufferPrefix(request.body as ReadableStream<Uint8Array>));
    } catch {
      return fail(request, "读取上传内容失败，请重试");
    }
    const sniff = sniffFileType(head);
    const typeMismatch = isTypeMismatch(extension, sniff);
    const guard = await getContentTypeGuard();
    const guardOutcome = applyContentGuard(guard, extension, sniff);
    if (guardOutcome.verdict === "reject") {
      await appendAudit(actor, "内容类型校验拒绝", id, "REJECTED_BY_RULE", JSON.stringify({
        fileName, extension, guard, detectedKind: sniff.kinds.join(",") || "unknown", detectedExtensions: sniff.extensions.join(",") || null, evidence: sniff.evidence, reason: guardOutcome.reason,
      }));
      return failWithStream(bodyStream, guardOutcome.message, 403);
    }

    // 已知大小时先做一次快速否决：命中「拒绝」规则的文件不写进隔离区（保持原有口径）。
    // guard=manual（未知类型转人工）也要过这道闸：拒绝比转人工更严格，从严执行。
    if (declared > 0) {
      const precheckExtensions = guardOutcome.verdict === "pass" ? guardOutcome.extensions : [extension];
      const precheck = await evaluateFileDetailed(precheckExtensions, declared, department);
      if (precheck.rule.action === "拒绝") return failWithStream(bodyStream, `命中禁止发送规则（${precheck.rule.name}）`, 403);
    }

    const safeName = fileName.replace(/[^\p{L}\p{N}._-]+/gu, "_").slice(0, 180);
    const objectKey = `quarantine/${id}/${safeName}`;

    let sizeBytes: number;
    let sha256: string;
    try {
      ({ sizeBytes, sha256 } = await putStreamWithDigest(storage(), objectKey, bodyStream, {
        contentType: request.headers.get("content-type") || "application/octet-stream",
        applicationId: id,
        lengthBytes: declared,
      }));
    } catch (error) {
      // 上传中途失败（超限/连接中断）会留下半截对象，这里清理掉
      await storage().delete(objectKey).catch(() => undefined);
      if (error instanceof UploadTooLargeError) return fail(request, error.message, 413);
      if (error instanceof UploadLengthRequiredError) return fail(request, error.message, 411);
      throw error;
    }
    // 真实大小只有落盘后才知道：空文件与规则判定都以它为准
    if (!sizeBytes) {
      await storage().delete(objectKey).catch(() => undefined);
      return jsonError("文件内容为空（0 字节），请选择有内容的文件后再提交");
    }

    // 正式判定：参与匹配的后缀集合 = 声明后缀 ∪ 嗅探候选后缀（从严合并）；未知类型兜底转人工
    const matchedExtensions = guardOutcome.verdict === "pass" ? guardOutcome.extensions : [extension];
    const evaluation = await evaluateFileDetailed(matchedExtensions, sizeBytes, department);
    const matched = evaluation.rule;
    // 发起人回避：规则指派的审批人若包含发起人本人则剔除；剔除后为空则回退管理员/审批人角色兜底（assignedApprovers=null）
    const ruleApprovers = parseApproverEmails(matched.approverEmails);
    const selfExcluded = ruleApprovers.filter((email) => email !== (actor.email || "").toLowerCase());
    const approversExcludedSelf = ruleApprovers.length > 0 && selfExcluded.length === 0;
    const assignedApprovers = selfExcluded.length ? selfExcluded.join(",") : null;
    // 未知类型兜底（guard=manual）：除规则「拒绝」外一律转人工
    const forcedManual = guardOutcome.verdict === "manual" && matched.action !== "拒绝";
    const finalAction = forcedManual ? "转人工审批" : matched.action;
    const status = finalAction === "拒绝" ? APPLICATION_STATUS.REJECTED_BY_RULE : finalAction === "自动通过" ? APPLICATION_STATUS.APPROVED : APPLICATION_STATUS.PENDING_APPROVAL;
    // 判定说明：拒绝说明命中规则；转人工时给出「命中规则」或兜底未命中的具体原因；
    // 后续审批/送达会覆盖该字段，因此这里只负责让待审批阶段可解释。
    const decisionReason = finalAction === "拒绝"
      ? `命中禁止发送规则（${matched.name}）`
      : forcedManual
        ? guardOutcome.message
        : finalAction === "转人工审批"
          ? (approversExcludedSelf
              ? (evaluation.fallbackReason ? `${evaluation.fallbackReason}；规则审批人与发起人相同，已转由管理员/其他审批人处理` : "规则审批人与发起人相同，已转由管理员/其他审批人处理")
              : (evaluation.fallbackReason || `命中规则「${matched.name}」，按规则转人工审批`))
          : null;

    // recipientId/recipientName 为旧模型遗留列（NOT NULL），新模型冗余存首位收件人，完整名单见 application_recipients
    const row = { id, fileName, extension, sizeBytes, requesterId: actor.id, requesterEmail: actor.email, requesterName: actor.display, department, recipientId: firstRecipient.email, recipientName: firstRecipient.name, description, status, ruleId: matched.id, ruleName: matched.name, objectKey, sha256, decisionReason, approverId: null, approverEmail: null, assignedApprovers, detectedKind: sniff.kinds.join(",") || "unknown", detectedExtensions: sniff.extensions.join(",") || null, typeMismatch, contentSignature: sniff.evidence, createdAt: now, updatedAt: now };
    await db.insert(applications).values(row);
    await db.insert(applicationRecipients).values(recipientRows.map((user) => ({
      id: `${id}-${crypto.randomUUID().slice(0, 8)}`,
      applicationId: id,
      email: user.email,
      name: user.name,
      department: user.department,
      createdAt: now,
    })));

    // 规则引擎判定为"自动通过"的发送单：进入统一送达 pipeline（APPROVED → TRANSFERRING → TRANSFERRED）
    if (finalAction === "自动通过") {
      const inserted = (await db.select().from(applications).where(eq(applications.id, id)).limit(1))[0];
      const pipeline = await runDeliveryPipeline(inserted, actor, { trigger: "规则自动通过" });
      await appendAudit(actor, "上传并提交发送单", id, `${pipeline.status}；命中 ${matched.id}（规则自动通过）`, JSON.stringify({ fileName, extension, sizeBytes, department, recipients: emails, ruleId: matched.id, sha256, status: pipeline.status, message: pipeline.message, detectedKind: sniff.kinds.join(",") || "unknown", typeMismatch, guard }));
      return Response.json({ ...row, status: pipeline.status, decisionReason: pipeline.message }, { status: 201 });
    }

    // ⑥ 邮件通知：转人工审批时的审批待办通知（先入队再后台发送，任何异常不影响提交结果）。
    // 收件人 = 规则/管理员指派的审批人；未指派时兜底通知「审批人」角色名单（roleAssignments + 环境变量）。
    if (status === APPLICATION_STATUS.PENDING_APPROVAL) {
      try {
        const requesterEmail = (actor.email || "").toLowerCase();
        const approvers = (assignedApprovers ? parseApproverEmails(assignedApprovers) : await fallbackApproverEmails())
          .filter((email) => email !== requesterEmail); // 发起人自己不收待办通知
        const queued = await notifyApprovalPending(
          { id, fileName, sizeBytes, requesterName: actor.display, department, description, decisionReason },
          approvers,
        );
        if (queued) dispatchMailOutbox();
      } catch { /* 通知失败不影响提交 */ }
    }

    await appendAudit(actor, "上传并提交发送单", id, `${status}；命中 ${matched.id}`, JSON.stringify({ fileName, extension, sizeBytes, department, recipients: emails, ruleId: matched.id, sha256, assignedApprovers: assignedApprovers || null, skippedRules: evaluation.skipped, decisionReason, detectedKind: sniff.kinds.join(",") || "unknown", detectedExtensions: sniff.extensions.join(",") || null, typeMismatch, guard }));
    return Response.json(row, { status: 201 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "提交发送单失败", 500);
  }
}
