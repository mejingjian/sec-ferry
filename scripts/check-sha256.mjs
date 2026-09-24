// 自检：验证 lib/sha256.ts 的增量 SHA-256 与 Node crypto 结果一致。
// 运行：node scripts/check-sha256.mjs
import { createHash, webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(__dirname, "..", "lib", "sha256.ts"), "utf8");

function extract(name) {
  const start = source.indexOf(`class ${name}`);
  if (start < 0) throw new Error(`未找到 ${name}`);
  let depth = 0;
  let i = source.indexOf("{", start);
  for (; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") { depth -= 1; if (depth === 0) break; }
  }
  return source.slice(start, i + 1);
}

// 去掉 TS 专属语法，得到可在 node 直接求值的 JS
function stripTs(code) {
  let out = code;
  let previous;
  do {
    previous = out;
    out = out.replace(/\b(private|public|protected|readonly)\s+/g, "");
  } while (out !== previous);
  return out
    .replace(/(\w+)\s*:\s*(Uint8Array|Uint32Array|number|string|boolean)\b/g, "$1")
    .replace(/\)\s*:\s*(Uint32Array|Uint8Array|number|void|string|boolean)\b/g, ")");
}

const rotrStart = source.indexOf("function rotr");
const rotrSource = source.slice(rotrStart, source.indexOf("}", source.indexOf("{", rotrStart)) + 1);
const code = `${stripTs(extract("IncrementalSha256"))}\n${stripTs(rotrSource)}\nreturn IncrementalSha256;`;
const IncrementalSha256 = new Function(code)();

function refHex(data) { return createHash("sha256").update(data).digest("hex"); }

let failures = 0;
function check(label, data, chunkSizes) {
  const hasher = new IncrementalSha256();
  let offset = 0;
  let i = 0;
  while (offset < data.length) {
    const size = chunkSizes[i % chunkSizes.length];
    hasher.update(data.subarray(offset, Math.min(offset + size, data.length)));
    offset += size;
    i += 1;
  }
  const got = hasher.hex();
  const want = refHex(data);
  const ok = got === want;
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${got}${ok ? "" : ` != ${want}`}`);
}

check("空输入", new Uint8Array(0), [64]);
check("abc", new TextEncoder().encode("abc"), [64]);
check("448-bit 边界", new TextEncoder().encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"), [64]);

const blockish = new Uint8Array(4096);
webcrypto.getRandomValues(blockish);
check("4096B 单块", blockish, [4096]);
check("4096B 7B 分片", blockish, [7]);
check("4096B 63/64/65 混切", blockish, [63, 64, 65]);
check("4096B 1B 分片", blockish.subarray(0, 600), [1]);

const big = new Uint8Array(1024 * 1024 + 37);
for (let offset = 0; offset < big.length; offset += 65536) {
  webcrypto.getRandomValues(big.subarray(offset, Math.min(offset + 65536, big.length)));
}
check("1MB+37 64KB 分片", big, [65536]);
check("1MB+37 不规则分片", big, [13, 1024, 65535, 3]);
check("1MB+37 恰好 64B 分片", big.subarray(0, 128), [64]);

const idempotent = new IncrementalSha256();
idempotent.update(new TextEncoder().encode("idempotent"));
const first = idempotent.hex();
const second = idempotent.hex();
if (first !== second) { failures += 1; console.log(`FAIL 幂等: ${first} != ${second}`); }
else console.log(`PASS 幂等: ${first}`);

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
