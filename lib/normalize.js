/**
 * 执行面公共件（D9 / D10）—— **结果规范化**与**转发目标禁令**的唯一实现。
 *
 * 为什么单独一个模块：这两件事同时被两处需要，而两处都不能互相 import ——
 *   · lib/proxy.js 要把转发结果交回模型（文本 + 结构化块），
 *   · lib/guardrail.js 只看文本视图做结果指纹，
 * 而 proxy.js 静态 import 了宿主包 @deepseek-ai/dsh-tools：guardrail 若反过来 import
 * proxy.js，护栏单测就必须先挂宿主解析钩子。本模块**零依赖**，两边都能直接用。
 *
 * 三条纪律（改这里之前先读）：
 *  1) 文本块按**单个换行**拼接（C34：拍平只有一个实现，分隔符不允许各处自选）。
 *  2) image / audio / resource 块**原样保留为结构化块**，绝不序列化成 base64 文本灌进 text
 *     （P1-8 / C33：图看不见的根因就是这里被 JSON.stringify 成字符串）。
 *  3) 超限只降级、不丢信息：降级成结构化占位摘要 { type, mimeType, estimatedBytes, truncated }，
 *     并在 text 里留一行说明；未知类型保留类型与浅层元数据并标记省略。
 */

/** 单块上限（默认 256 KB）。可按调用点收窄/放宽（测试用）。 */
export const DEFAULT_MAX_BLOCK_BYTES = 256 * 1024;
/** 单次结果的结构化载荷总量上限（默认 1 MB）。 */
export const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024;

/** 闸门工具族：一律禁止作为转发目标（C32 / P2-5）。 */
export const GATE_TOOL_FAMILY = Object.freeze([
  "gate_invoke",
  "gate_call",
  "gate_load",
  "gate_search",
  "gate_status",
]);

/** 可区分的拒绝原因码（不是文案：调用方/测试按码判定）。 */
export const GATE_TOOL_NOT_FORWARDABLE = "gate-tool-not-forwardable";

/**
 * 转发结果上「内层执行已计入」的标记（C40）。
 * proxy 转发成功后盖在**自己的输出对象**上；护栏看到它就跳过本次计数，
 * 于是「一次转发」在所有挂载点上只推进一次时钟（内外层不重复记账）。
 */
export const COUNTED_MARK = Symbol.for("dsh-gate.repeat-guard.counted");

/** 是不是闸门工具族（转发目标禁令的唯一判据）。 */
export const isGateToolName = (name) => typeof name === "string" && GATE_TOOL_FAMILY.includes(name);

/**
 * 准入判定：闸门工具族一律拒绝转发（否则 gate_invoke 可以自调 / 递归转发）。
 * @returns {{ok: true} | {ok: false, code: string, message: string}}
 */
export function forwardTargetRefusal(name) {
  if (!isGateToolName(name)) return { ok: true };
  return {
    ok: false,
    code: GATE_TOOL_NOT_FORWARDABLE,
    // 文案同时保留「不能自调」：0.5.7 的既有调用方/测试按这句字面判自调，语义也没变。
    message: name + ": 不能自调 —— " + name + " 属于闸门工具族，不能作为转发目标（它本身就是转发口）",
  };
}

/** 媒资块的 mime（三种宿主形状都认：mimeType / mediaType / source.media_type）。 */
function mimeOf(block) {
  const candidates = [
    block && block.mimeType,
    block && block.mediaType,
    block && block.source && block.source.media_type,
    block && block.source && block.source.mimeType,
  ];
  for (const value of candidates) if (typeof value === "string" && value.length > 0) return value;
  return undefined;
}

/** 载荷字节数估算：base64 按 3/4 折算，文本按 UTF-8 字节，URL/句柄按 0。 */
function estimatedBytesOf(block) {
  if (!block || typeof block !== "object") return 0;
  const direct = block.bytes ?? block.size;
  if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) return Math.floor(direct);
  const data = typeof block.data === "string" ? block.data : block.source && typeof block.source.data === "string" ? block.source.data : undefined;
  if (data !== undefined) {
    const payload = block.source && block.source.type === "base64" ? data : data;
    // base64 字符数 → 原始字节数（向上取整够用，只用于预算判断）。
    return Math.floor((payload.length * 3) / 4);
  }
  if (typeof block.text === "string") return Buffer.byteLength(block.text, "utf8");
  if (typeof block.url === "string") return 0;
  try { return Buffer.byteLength(JSON.stringify(block), "utf8"); } catch { return 0; }
}

/** 载荷字段：未知块里这些键一律不搬（base64 / 正文灌进上下文正是 P1-8 要防的事）。 */
const PAYLOAD_KEYS = new Set(["data", "text", "base64", "content", "body", "blob", "bytes_data"]);

/** 未知块的浅层元数据：只留标量字段，正文/载荷一律不搬（避免把 base64 灌进上下文）。 */
function shallowMetaOf(block) {
  const meta = {};
  for (const [key, value] of Object.entries(block || {})) {
    if (PAYLOAD_KEYS.has(key)) continue;
    if (value === null) { meta[key] = null; continue; }
    const kind = typeof value;
    if (kind === "string") { if (value.length <= 120) meta[key] = value; continue; }
    if (kind === "number" || kind === "boolean") { meta[key] = value; continue; }
  }
  return meta;
}

const isTextBlock = (block) => block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string";

/** 结构化块：原样保留（不 stringify）。resource 既可能是对象也可能是引用型块。 */
const KEEP_TYPES = new Set(["image", "audio", "resource"]);

/**
 * 唯一规范化器（D10）。
 *
 * @param {object} result 宿主工具结果（{ content, isError, value }）
 * @param {{maxBlockBytes?: number, maxTotalBytes?: number, textFallback?: boolean}} [options]
 * @returns {{
 *   contentBlocks: object[],   // 保真的结构化块（text 之外的）
 *   text: string,              // 文本视图（单个换行拼接 + 降级说明行）
 *   attachments: {type:string, mimeType?:string, estimatedBytes:number}[],
 *   truncated: boolean,
 *   dropped: {type:string, mimeType?:string, estimatedBytes?:number, reason:string, meta?:object}[],
 * }}
 */
export function normalizeToolResult(result, options) {
  const opts = options !== null && typeof options === "object" ? options : {};
  const maxBlockBytes = Number.isFinite(opts.maxBlockBytes) && opts.maxBlockBytes >= 0
    ? Math.floor(opts.maxBlockBytes)
    : DEFAULT_MAX_BLOCK_BYTES;
  const maxTotalBytes = Number.isFinite(opts.maxTotalBytes) && opts.maxTotalBytes >= 0
    ? Math.floor(opts.maxTotalBytes)
    : DEFAULT_MAX_TOTAL_BYTES;
  const contentBlocks = [];
  const attachments = [];
  const dropped = [];
  const parts = [];
  let totalBytes = 0;
  let truncated = false;

  const blocks = result && Array.isArray(result.content) ? result.content : [];
  for (const block of blocks) {
    if (block === undefined || block === null) continue;
    if (isTextBlock(block)) { parts.push(block.text); continue; }
    const type = typeof block.type === "string" && block.type.length > 0 ? block.type : "unknown";
    if (KEEP_TYPES.has(type)) {
      const mimeType = mimeOf(block);
      const estimatedBytes = estimatedBytesOf(block);
      const overBlock = estimatedBytes > maxBlockBytes;
      const overTotal = totalBytes + estimatedBytes > maxTotalBytes;
      if (overBlock || overTotal) {
        // 降级：结构化占位摘要（类型 / 尺寸 / 估算字节 / 截断标记），正文不搬。
        truncated = true;
        const reason = overBlock ? "block-limit" : "total-limit";
        const placeholder = {
          type,
          ...(mimeType === undefined ? {} : { mimeType }),
          estimatedBytes,
          truncated: true,
        };
        contentBlocks.push(placeholder);
        attachments.push({ type, ...(mimeType === undefined ? {} : { mimeType }), estimatedBytes, truncated: true });
        dropped.push({ type, ...(mimeType === undefined ? {} : { mimeType }), estimatedBytes, reason });
        parts.push("[omitted " + type + (mimeType ? " " + mimeType : "") + " ~" + estimatedBytes + " bytes (" + reason + ")]");
        continue;
      }
      totalBytes += estimatedBytes;
      // 原样保留：不再复制、不 stringify（引用同一份宿主块）。
      contentBlocks.push(block);
      attachments.push({ type, ...(mimeType === undefined ? {} : { mimeType }), estimatedBytes });
      continue;
    }
    // 未知类型：保留类型 + 浅层元数据，正文省略并标记（不猜它是不是文本）。
    truncated = true;
    dropped.push({ type, ...(mimeOf(block) === undefined ? {} : { mimeType: mimeOf(block) }), reason: "unknown-type", meta: shallowMetaOf(block) });
    parts.push("[omitted block type=" + type + " (unknown-type)]");
  }
  // 只有 value、没有 content 的宿主结果（gate_status 这种结构化输出）：文本视图给一份 JSON。
  if (parts.length === 0 && result && result.value !== undefined) {
    try { parts.push(JSON.stringify(result.value)); } catch { /* 不可序列化就不给视图 */ }
  }
  return {
    contentBlocks,
    text: parts.join("\n"),
    attachments,
    truncated,
    dropped,
  };
}

/** 只要文本视图的地方（护栏指纹 / 重试判据）走同一个实现，不再各自写一份拍平。 */
export function textViewOf(result, options) {
  return normalizeToolResult(result, options).text;
}
