import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { projectRoot } from "./sites-env.mjs";

const userConfigPath = path.join(projectRoot, "local.config.json");
if (!existsSync(userConfigPath)) {
  writeFileSync(userConfigPath, JSON.stringify({
    configEncryptionKey: randomBytes(32).toString("hex"),
  }, null, 2) + "\n", { mode: 0o600 });
  console.log("已生成 local.config.json（该文件不会提交到 Git）。");
}

// 外网交付网关（Delivery Gateway）本地默认值：不覆盖用户在 local.config.json 已显式配置的值
const local = JSON.parse(readFileSync(userConfigPath, "utf8"));
if (typeof local.configEncryptionKey !== "string" || local.configEncryptionKey.length < 32) {
  throw new Error("local.config.json 中的 configEncryptionKey 至少需要 32 个字符。");
}
const deliveryDefaults = {
  deliveryGatewayEndpoint: "http://127.0.0.1:8790",
  deliveryGatewayToken: "local-test-token",
  deliveryPublicBaseUrl: "http://127.0.0.1:8790",
  deliveryDefaultExpiryHours: "72",
  deliveryDefaultMaxDownloads: "5",
  quarantineRetentionDays: "7",
};
let changed = false;
for (const [key, value] of Object.entries(deliveryDefaults)) {
  if (local[key] === undefined) { local[key] = value; changed = true; }
}
if (changed) writeFileSync(userConfigPath, JSON.stringify(local, null, 2) + "\n", { mode: 0o600 });

const sourcePath = path.join(projectRoot, "dist/server/wrangler.json");
const targetPath = path.join(projectRoot, "dist/server/wrangler.local.json");
const wrangler = JSON.parse(readFileSync(sourcePath, "utf8"));
wrangler.vars = {
  CONFIG_ENCRYPTION_KEY: local.configEncryptionKey,
  ...(local.deliveryGatewayEndpoint ? { DELIVERY_GATEWAY_ENDPOINT: local.deliveryGatewayEndpoint } : {}),
  ...(local.deliveryGatewayToken ? { DELIVERY_GATEWAY_TOKEN: local.deliveryGatewayToken } : {}),
  ...(local.deliveryPublicBaseUrl ? { DELIVERY_PUBLIC_BASE_URL: local.deliveryPublicBaseUrl } : {}),
  ...(local.deliveryDefaultExpiryHours ? { DELIVERY_DEFAULT_EXPIRY_HOURS: local.deliveryDefaultExpiryHours } : {}),
  ...(local.deliveryDefaultMaxDownloads ? { DELIVERY_DEFAULT_MAX_DOWNLOADS: local.deliveryDefaultMaxDownloads } : {}),
  ...(local.quarantineRetentionDays ? { QUARANTINE_RETENTION_DAYS: local.quarantineRetentionDays } : {}),
};
writeFileSync(targetPath, JSON.stringify(wrangler, null, 2) + "\n");
console.log("本地运行配置已生成。");
