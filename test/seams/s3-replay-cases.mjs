/**
 * S3 回放表（工单 #06 · F67–F79 / P1-1 / P1-10）
 *
 * 一张数据表，把"0.5.7 是什么样 → #06 之后是什么样"写死下来：
 *   - before：0.5.7 的观测（status / ended / code 的旧样子）
 *   - after ：新契约（status + 稳定 code；details 里预期的键）
 *
 * 用途有三：
 *   1. s3-http-contract.test.mjs 用它断言"回放表里的 code 都真的在闭合表里"，
 *      防止有人加了个码却忘了映射状态码；
 *   2. 缺陷登记（test/seams/defect-registry.mjs）与它的对应关系一目了然（P1-1 / P1-10）；
 *   3. 后续工单要改状态码时，先改这张表，再改实现 —— 它是契约的文本形态。
 *
 * 注意：这张表**不执行**请求（执行在 s3-http-contract.test.mjs 的 check 里），
 * 只描述期望。这样表可以独立被 #07/#08 引用，不会因为夹具变化而失效。
 */
export const REPLAY_CASES = Object.freeze([
  Object.freeze({
    id: "P1-1-abort",
    defect: "P1-1",
    feature: "F67",
    seam: "S3",
    probe: "POST /api/dsh-gate/policy：客户端读完请求头后断连（流迭代器抛 ECONNRESET）",
    before: Object.freeze({ status: undefined, ended: false, note: "readJsonBody 直接抛，handler 内无 try/catch ⇒ 永不写响应，连接挂到宿主超时" }),
    after: Object.freeze({ status: 500, code: "INTERNAL", details: Object.freeze(["reason"]) }),
    test: "八步·4 读体：客户端中途断连 → 500 INTERNAL 结构化信封并真的写了响应（P1-1）",
  }),
  Object.freeze({
    id: "P1-10-tier-null",
    defect: "P1-10",
    feature: "F69",
    seam: "S3",
    probe: "POST /api/dsh-gate/skills：{action:'tier', name:'alpha-skill', tier:null}",
    before: Object.freeze({ status: 200, note: "Number(null) === 0 ⇒ 被当成 0（关闭）写盘，技能被静默关掉" }),
    after: Object.freeze({ status: 400, code: "INVALID_TIER", details: Object.freeze(["received"]) }),
    test: "P1-10：tier: null 不再被 Number() 强转成 0（400 INVALID_TIER，文件不动）",
  }),
  Object.freeze({
    id: "F71-oversized-stream",
    feature: "F71",
    probe: "POST /api/dsh-gate/policy：实际读体超过 512 KiB",
    before: Object.freeze({ status: 400, note: "readJsonBody 返回 undefined ⇒ 被当成 JSON 解析失败 400，且不消费请求体" }),
    after: Object.freeze({ status: 413, code: "PAYLOAD_TOO_LARGE", details: Object.freeze(["limit", "read"]) }),
  }),
  Object.freeze({
    id: "F71-declared-length",
    feature: "F71",
    probe: "POST /api/dsh-gate/policy：Content-Length 声明 512 KiB + 1",
    before: Object.freeze({ status: 400, readBody: true }),
    after: Object.freeze({ status: 413, code: "PAYLOAD_TOO_LARGE", details: Object.freeze(["declared", "limit", "read"]) }),
    test: "八步·3 声明长度：Content-Length 超限 → 413 且**一个字节都不读**",
  }),
  Object.freeze({
    id: "F71-method-put",
    feature: "F71",
    probe: "PUT /api/dsh-gate/state（0.5.7 不判方法，PUT 被当 GET 处理）",
    before: Object.freeze({ status: 200, note: "handler 只看 req.method === 'POST'，其余一律按 GET 处理" }),
    after: Object.freeze({ status: 405, code: "METHOD_NOT_ALLOWED", headers: Object.freeze(["allow"]) }),
  }),
  Object.freeze({
    id: "F72-new-route-auth",
    feature: "F72",
    probe: "任何新增路由 × 三类不可信请求（跨站 origin / 非回环来源 / rebinding Host）",
    before: Object.freeze({ status: 200, note: "新增路由要自己记得写鉴权；漏了就是 200（遍历测试靠人写）" }),
    after: Object.freeze({ status: 403, code: "FORBIDDEN" }),
    test: "八步·6 鉴权：三类不可信请求 × 六条路由 → 401/403 且真的写了响应",
  }),
  Object.freeze({
    id: "F72-agent-404",
    feature: "F72",
    probe: "GET /api/dsh-gate/state?agent=<不存在>",
    before: Object.freeze({ status: 404, error: "agent not found", note: "只有 error 字符串与 agents 清单，没有稳定 code" }),
    after: Object.freeze({ status: 404, code: "AGENT_NOT_FOUND", details: Object.freeze(["requested", "agents"]) }),
  }),
  Object.freeze({
    id: "F70-save-failure",
    feature: "F70",
    probe: "POST /api/dsh-gate/policy：写盘失败（临时文件 rename 失败 / 磁盘满）",
    before: Object.freeze({ status: 200, ok: true, note: "失败结果被当作成功体，面板显示已保存" }),
    after: Object.freeze({ status: 500, code: "INTERNAL" }),
  }),
  Object.freeze({
    id: "F73-revision-conflict",
    feature: "F73",
    probe: "POST /api/dsh-gate/policy：expectedRevision 与磁盘不一致",
    after: Object.freeze({ status: 409, code: "REVISION_CONFLICT", details: Object.freeze(["expectedRevision", "currentRevision"]) }),
  }),
  Object.freeze({
    id: "F73-policy-unreadable",
    feature: "F73",
    probe: "POST /api/dsh-gate/policy：策略文件坏 JSON，未带 forceOverwriteCorrupt",
    after: Object.freeze({ status: 409, code: "POLICY_UNREADABLE", details: Object.freeze(["fileState", "readDiagnostic"]) }),
  }),
  Object.freeze({
    id: "F73-confirmation-required",
    feature: "F73",
    probe: "POST /api/dsh-gate/policy：{replace:true} 不带 acknowledge",
    before: Object.freeze({ status: 200, note: "整份替换直接落盘，被删掉的能力键无人知晓" }),
    after: Object.freeze({ status: 409, code: "CONFIRMATION_REQUIRED", details: Object.freeze(["willDelete", "currentRevision"]) }),
    test: "（test/server-skills.test.mjs 2.8 已补 acknowledge:true）",
  }),
  Object.freeze({
    id: "F73-media-type",
    feature: "F73",
    probe: "POST /api/dsh-gate/policy：content-type: text/plain",
    before: Object.freeze({ status: 415, note: "只有 message，没有 code" }),
    after: Object.freeze({ status: 415, code: "UNSUPPORTED_MEDIA_TYPE" }),
  }),
  Object.freeze({
    id: "F77-import-unc",
    feature: "F77",
    probe: "POST /api/dsh-gate/skills：{action:'imports', imports:['\\\\server\\share']}",
    before: Object.freeze({ status: 400, note: "只判 fs.existsSync，UNC/设备路径会在网络栈上被摸一下" }),
    after: Object.freeze({ status: 400, code: "IMPORT_PATH_UNSAFE" }),
  }),
  Object.freeze({
    id: "F74-diagnostics",
    feature: "F74",
    probe: "GET /api/dsh-gate/diagnostics[?agent=]",
    before: Object.freeze({ status: 404, note: "0.5.7 没有这条路由" }),
    after: Object.freeze({ status: 200, code: null, groups: Object.freeze(["read", "decisions", "runtime", "errors"]) }),
  }),
  Object.freeze({
    id: "F79-batch",
    feature: "F79",
    probe: "POST /api/dsh-gate/skills：{action:'batch', operations:[…]}",
    before: Object.freeze({ status: 400, note: "0.5.7 只认 tier/off/imports/takeover，面板要发 N 次请求，中间失败就是部分落盘" }),
    after: Object.freeze({ status: 200, applied: "per-operation", note: "一次归一 / 一次落盘 / 一次预扫描；单条非法整批拒绝" }),
  }),
]);

/** 回放表里出现过的全部 code（含业务扩展码）。 */
export function replayCodes() {
  const codes = new Set();
  for (const row of REPLAY_CASES) {
    if (row.before && typeof row.before.code === "string") codes.add(row.before.code);
    if (row.after && typeof row.after.code === "string") codes.add(row.after.code);
  }
  return [...codes].sort();
}
