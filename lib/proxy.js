/**
 * 闸门自己的 4 个工具。它们永远常驻（policy.protectedNames），否则闸门没法自我恢复。
 * 注册在根 ctx → 对 agent 而言是“继承的全局工具”，会进 PTC SDK 声明。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { searchCatalog, estimateTokens } from "./catalog.js";

const textOf = (result) => {
  if (!result || !Array.isArray(result.content)) return "";
  const parts = [];
  for (const block of result.content) {
    if (block === undefined || block === null) continue;
    if (typeof block.text === "string") parts.push(block.text);
    else parts.push(JSON.stringify(block));
  }
  return parts.join("\n");
};

export function registerGateTools(options) {
  const gate = options.gate;
  const policy = options.policy;
  const disposers = [];

  disposers.push(options.ctx.tools.register(defineTool({
    name: "gate_status",
    description: "查看 dsh-gate 当前分层：哪些工具常驻、哪些按需、哪些关闭，以及目录占了多少 token。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean" },
          visible: { type: "number" },
          resident: { type: "number" },
          onDemand: { type: "number" },
          off: { type: "number" },
          gated: { type: "number" },
          catalogTokens: { type: "number" },
          policyFile: { type: "string" },
          residentNames: { type: "array", items: { type: "string" } },
          onDemandNames: { type: "array", items: { type: "string" } },
          offNames: { type: "array", items: { type: "string" } },
          loaded: { type: "array", items: { type: "string" } },
          ownNames: { type: "array", items: { type: "string" } },
          // preset 平面（agent preset 注册、默认不受管）的工具名，只给 UI/排障用。
          presetNames: { type: "array", items: { type: "string" } },
          catalogChars: { type: "number" },
          // 下面两项 status() 一直返回，schema 却漏了 → additionalProperties:false 让真机必失败。
          sections: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                chars: { type: "number" },
                tokens: { type: "number" },
                gated: { type: "boolean" },
              },
            },
          },
          skills: { type: "array", items: { type: "string" } },
        },
      },
      render(args, value) {
        const lines = [];
        lines.push("dsh-gate: " + (value.enabled ? "启用" : "已禁用") + "（策略 " + (value.policyFile || "(内置默认)") + "）");
        lines.push("可见工具 " + value.visible + " 个 → 常驻 " + value.resident + " / 按需 " + value.onDemand + " / 关闭 " + value.off);
        lines.push("实际被隐藏 " + value.gated + " 个；目录约 " + value.catalogTokens + " tokens");
        if (value.loaded.length > 0) lines.push("本轮已加载: " + value.loaded.join(", "));
        if (value.offNames.length > 0) lines.push("已关闭: " + value.offNames.join(", "));
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(args, exec) {
      return gate.status(exec.agent);
    },
  })));

  disposers.push(options.ctx.tools.register(defineTool({
    name: "gate_search",
    description: "在第二层（按需/关闭）里按关键词找工具或技能，返回名字与一句话说明。",
    parameters: {
      query: { type: "string", description: "关键词，匹配名字或说明" },
      limit: { type: "number", description: "最多返回几条，默认 12" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          results: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                tier: { type: "string" },
              },
            },
          },
        },
      },
      render(args, value) {
        if (value.results.length === 0) return [{ type: "text", text: "没有匹配项。" }];
        const lines = value.results.map((r) => "- " + r.name + " [" + r.tier + "]" + (r.description ? " — " + r.description : ""));
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(args, exec) {
      const status = gate.status(exec.agent);
      const pool = [];
      for (const name of status.residentNames) pool.push({ name, tier: "常驻" });
      for (const name of status.onDemandNames) pool.push({ name, tier: "按需" });
      for (const name of status.offNames) pool.push({ name, tier: "关闭" });
      const entry = gate.entries.get(exec.agent);
      if (entry && Array.isArray(entry.skills)) {
        for (const skill of entry.skills) pool.push({ name: "skill:" + skill.name, description: skill.description, tier: "技能" });
      }
      const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.min(50, Math.floor(args.limit)) : 12;
      const hits = searchCatalog(pool, args.query, limit);
      return { results: hits.map((hit) => ({ name: hit.name, description: String(hit.description || "").slice(0, 120), tier: hit.tier })) };
    },
  })));

  disposers.push(options.ctx.tools.register(defineTool({
    name: "gate_load",
    description: "把第二层的工具/技能提到第一层常驻（下一步即可直接调用）。传 skill:<名字> 加载技能正文。",
    parameters: {
      names: { type: "array", items: { type: "string" }, description: "要加载的名字，如 [\"univer_sheet\"] 或 [\"skill:office\"]" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          loaded: { type: "array", items: { type: "string" } },
          unknown: { type: "array", items: { type: "string" } },
          skillText: { type: "string" },
        },
      },
      render(args, value) {
        const lines = [];
        if (value.loaded.length > 0) lines.push("已加载: " + value.loaded.join(", ") + "（下一步可直接调用）");
        if (value.unknown.length > 0) lines.push("没找到: " + value.unknown.join(", ") + "（用 gate_search 查准确名字）");
        if (value.skillText) lines.push("", value.skillText);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(args, exec) {
      const names = Array.isArray(args.names) ? args.names : [];
      const skillNames = names.filter((n) => typeof n === "string" && n.startsWith("skill:")).map((n) => n.slice(6));
      const toolNames = names.filter((n) => typeof n === "string" && !n.startsWith("skill:"));
      const result = await gate.load(exec.agent, toolNames);
      let skillText = "";
      for (const skillName of skillNames) {
        try {
          const forwarded = await gate.callThrough(exec.agent, "skill", { name: skillName }, exec.signal, exec.parent);
          const text = textOf(forwarded);
          if (text) skillText += (skillText ? "\n\n" : "") + text;
        } catch (error) {
          skillText += (skillText ? "\n\n" : "") + "技能 " + skillName + " 加载失败: " + String((error && error.message) || error);
        }
      }
      return { loaded: result.loaded, unknown: result.unknown, skillText };
    },
  })));

  disposers.push(options.ctx.tools.register(defineTool({
    name: "gate_call",
    description: "直接调用一个被闸门隐藏的工具（不必先 gate_load）。参数与目标工具一致。",
    parameters: {
      name: { type: "string", description: "目标工具名" },
      arguments: { type: "object", additionalProperties: true, description: "目标工具的参数对象" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          isError: { type: "boolean" },
        },
      },
      render(args, value) {
        return [{ type: "text", text: value.text }];
      },
    },
    async execute(args, exec) {
      const name = String(args.name || "").trim();
      if (name === "") throw new Error("gate_call: name 不能为空");
      const forwarded = await gate.callThrough(exec.agent, name, args.arguments || {}, exec.signal, exec.parent);
      return { text: textOf(forwarded), isError: forwarded && forwarded.isError === true };
    },
  })));

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose(); } catch { /* 忽略 */ }
    }
  };
}
