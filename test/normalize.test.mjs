/**
 * D9 / D10 / I-13：执行面结果规范化只有这一份实现。
 *
 * 这里守三件事：
 *   1. 文本块按单个换行拼接（拍平不允许各处自选分隔符）；
 *   2. image / audio / resource 原样保留为结构化块（绝不 stringify / base64 进 text）；
 *   3. 超限只降级成结构化占位摘要，未知类型保留类型并标记省略。
 */
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_BLOCK_BYTES,
  GATE_TOOL_FAMILY,
  forwardTargetRefusal,
  isGateToolName,
  normalizeToolResult,
  textViewOf,
} from "../lib/normalize.js";

const results = [];
const check = (label, fn) => {
  try { fn(); results.push({ ok: true, label }); }
  catch (error) { results.push({ ok: false, label, error }); }
};

check("文本块按单个换行拼接，空块忽略", () => {
  const out = normalizeToolResult({ content: [
    { type: "text", text: "a" },
    null,
    { type: "text", text: "b" },
    { type: "text", text: "c" },
  ] });
  assert.equal(out.text, "a\nb\nc");
  assert.equal(out.truncated, false);
  assert.deepEqual(out.contentBlocks, []);
});

check("image / audio / resource 原样保留（同一引用），绝不进 text", () => {
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
  const audio = { type: "audio", source: { type: "base64", media_type: "audio/wav", data: "BBBB" } };
  const resource = { type: "resource", resource: { uri: "file:///x", text: "hello" } };
  const out = normalizeToolResult({ content: [{ type: "text", text: "see" }, image, audio, resource] });
  assert.equal(out.text, "see");
  assert.equal(out.contentBlocks.length, 3);
  assert.equal(out.contentBlocks[0], image);
  assert.equal(out.contentBlocks[1], audio);
  assert.equal(out.contentBlocks[2], resource);
  assert.deepEqual(out.attachments.map((row) => row.type), ["image", "audio", "resource"]);
  assert.equal(/base64|AAAA/.test(out.text), false);
});

check("超单块上限：降级为结构化占位摘要并保留说明行", () => {
  const big = { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(64) } };
  const out = normalizeToolResult({ content: [big] }, { maxBlockBytes: 4, maxTotalBytes: 1024 });
  assert.equal(out.truncated, true);
  assert.deepEqual(out.dropped.map((row) => row.reason), ["block-limit"]);
  assert.equal(out.contentBlocks[0].truncated, true);
  assert.equal(out.contentBlocks[0].type, "image");
  assert.match(out.text, /omitted image/);
  assert.equal(out.attachments[0].truncated, true);
});

check("未知类型：保留类型与浅层元数据，正文标记省略", () => {
  const out = normalizeToolResult({ content: [{ type: "video", mimeType: "video/mp4", bytes: 12 }] });
  assert.equal(out.truncated, true);
  assert.deepEqual(out.dropped.map((row) => row.reason), ["unknown-type"]);
  assert.match(out.text, /unknown-type/);
  assert.equal(out.contentBlocks.length, 0);
});

check("只有 value 没有 content：文本视图给 JSON", () => {
  const out = normalizeToolResult({ value: { enabled: true, tier: 2 } });
  assert.equal(out.text, '{"enabled":true,"tier":2}');
  assert.equal(textViewOf({ value: { a: 1 } }), '{"a":1}');
});

check("空结果：空文本、无块、不抛", () => {
  const out = normalizeToolResult({});
  assert.equal(out.text, "");
  assert.deepEqual(out.contentBlocks, []);
  assert.deepEqual(out.dropped, []);
  assert.equal(out.truncated, false);
});

check("gate 工具族：一律禁止作为转发目标", () => {
  assert.equal(isGateToolName("gate_call"), true);
  assert.equal(isGateToolName("gate_load"), true);
  assert.equal(isGateToolName("read_file"), false);
  for (const name of GATE_TOOL_FAMILY) {
    const refusal = forwardTargetRefusal(name);
    assert.equal(refusal.ok, false, name + " 必须被拒绝");
    assert.equal(refusal.code, "gate-tool-not-forwardable");
  }
  assert.equal(forwardTargetRefusal("read_file").ok, true);
});

check("默认上限是 256 KB（单块）—— 常量不允许被悄悄改小", () => {
  assert.equal(DEFAULT_MAX_BLOCK_BYTES, 256 * 1024);
});

console.log("");
for (const row of results) {
  if (row.ok) console.log("  ok    " + row.label);
  else { console.log("  FAIL  " + row.label + "  →  " + (row.error && row.error.message ? row.error.message : row.error)); process.exitCode = 1; }
}
const failed = results.filter((row) => row.ok === false).length;
console.log("");
console.log((results.length - failed) + "/" + results.length + " passed");
