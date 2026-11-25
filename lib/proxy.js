/**
 * 闸门自己的 5 个工具。它们永远常驻（policy.protectedNames），否则闸门没法自我恢复。
 * gate_invoke 是 PTC 冻结下唯一的执行口（工单 07）：工具表不再随 gate_load 变化，
 * 已加载的能力一律从这里走宿主完整管线。
 * 注册在根 ctx → 对 agent 而言是"继承的全局工具"，会进 PTC SDK 声明。
 *
 * 0.6.0（票 #04）把两个转发入口收成**一个处理器**：gate_call 与 gate_invoke 只差
 * 主键名、错误前缀与准入策略，别的行为（闸门族禁令、取消透传、结果规范化）必须同源，
 * 否则同一个缺陷要在两处各修一遍（P1-8 就是这么漏的）。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { normalizeSearchLimit, searchCatalog } from "./catalog.js";
import { STATUS_KEYS, pickStatus } from "./gate.js";
import {
  GATE_TOOL_NOT_FORWARDABLE,
  forwardTargetRefusal,
  normalizeToolResult,
} from "./normalize.js";

/**
 * gate_status 每个输出键的类型声明 —— 与 gate.js 的 STATUS_KEYS 一一对应。
 * 属性顺序按 STATUS_KEYS 排（不是按这张表的书写顺序）：宿主的前缀缓存要求
 * 工具声明逐字节稳定，键序一变就从那一刻起失效。
 */
const STATUS_PROPERTIES = {
  enabled: { type: "boolean" },
  visible: { type: "number" },
  resident: { type: "number" },
  onDemand: { type: "number" },
  off: { type: "number" },
  gated: { type: "number" },
  // 0.1.7：委派收窄豁免是否生效（true = 该 agent 整台跳过闸门）。
  passthrough: { type: "boolean" },
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
};

/** 按唯一清单排出属性对象；缺一条就当场抛（宁可启动失败，也别在真机上 additionalProperties）。 */
function statusSchemaProperties() {
  const properties = {};
  for (const key of STATUS_KEYS) {
    const spec = STATUS_PROPERTIES[key];
    if (spec === undefined) throw new Error("dsh-gate: gate_status 缺 " + key + " 的类型声明");
    properties[key] = spec;
  }
  return properties;
}

/**
 * 目标工具名的取值：主键优先，为空再取别名键。
 *
 * gate_call 叫 name、gate_invoke 叫 tool —— 同一个概念两个键名，模型按另一个工具的习惯写就必然失败
 * （2026-11-14 真机复现：给 gate_call 传 { tool: "deck_issue_list" } 直接抛「name 不能为空」）。
 * 所以两个工具都认这两个键；两个都为空才报错，报错文本同时点出两个键名，模型一次就能改对。
 * 判空口径沿用旧实现（String(x || "").trim()），不是「有键就取」，空串仍然要让位给别名。
 */
export function resolveTargetName(args, primary, alias) {
  const source = args !== null && typeof args === "object" ? args : {};
  const valueOf = (key) => (source[key] ? String(source[key]).trim() : "");
  const fromPrimary = valueOf(primary);
  if (fromPrimary !== "") return fromPrimary;
  return valueOf(alias);
}

/** 单通道激活回执 schema（0.7.2：waterfall 与 emit 两条通道共用同一形状）。 */
const RELAY_CHANNEL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { type: "string" },
    listeners: { type: "number" },
    delivered: { type: "number" },
    failed: { type: "array", items: { type: "string" } },
  },
};

/** 中继回执的 schema 形状：gate_load 的逐技能回执与聚合回执共用。 */
const RELAY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    mode: { type: "string" },
    listeners: { type: "number" },
    delivered: { type: "number" },
    failed: { type: "array", items: { type: "string" } },
    waterfall: RELAY_CHANNEL_SCHEMA,
    emit: RELAY_CHANNEL_SCHEMA,
  },
};

/** 单个技能激活回执的 schema 形状：activation 兼容视图与 receipts[] 项共用。 */
const ACTIVATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    skill: { type: "string" },
    conditional: { type: "number" },
    promoted: { type: "array", items: { type: "string" } },
    relay: RELAY_SCHEMA,
    diagnostic: { type: "string" },
  },
};

/** 转发类工具的输出 schema：文本 + **可选结构化块**（图片/音频/资源原样带回，C33）。 */
const FORWARD_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: { type: "string" },
    isError: { type: "boolean" },
    // 结构化块：不序列化、不落成 base64 文本。宿主把它当原生 content block 渲染。
    blocks: { type: "array", items: { type: "object", additionalProperties: true } },
    truncated: { type: "boolean" },
  },
};

/**
 * 渲染一次转发结果：**先文本、后结构化块**。
 * 文本为空但有块时不塞空文本块（模型看到的顺序与宿主原始结果一致）。
 */
function renderForwarded(value) {
  const blocks = Array.isArray(value && value.blocks) ? value.blocks : [];
  const text = value && typeof value.text === "string" ? value.text : "";
  const out = [];
  if (text.length > 0 || blocks.length === 0) out.push({ type: "text", text });
  for (const block of blocks) out.push(block);
  return out;
}

/**
 * 统一转发处理器（D9）：两个入口共用，只在主名/别名、错误前缀、准入策略上参数化。
 *
 * 拒绝闸门工具族的判据是 normalize.js 的 forwardTargetRefusal（唯一实现），
 * 错误对象带 code=gate-tool-not-forwardable，调用方/测试按码判定，不靠文案猜。
 */
function makeForwarder(spec) {
  const label = spec.label;
  return async function execute(args, exec) {
    const name = resolveTargetName(args, spec.primary, spec.alias);
    if (name === "") throw new Error(label + ": " + spec.primary + " 不能为空（" + spec.alias + " 也可以："
      + spec.primary + " / " + spec.alias + " 二选一，传目标工具名）");
    const refusal = forwardTargetRefusal(name);
    if (refusal.ok !== true) {
      const error = new Error(label + ": " + refusal.message);
      error.code = GATE_TOOL_NOT_FORWARDABLE;
      throw error;
    }
    const verdict = spec.admission === "invoke" ? gateCanInvoke(spec.gate, exec, name) : gateCanCall(spec.gate, exec, name);
    if (!verdict.ok) {
      const error = new Error(label + ": " + verdict.message);
      error.code = "gate-target-not-invocable";
      throw error;
    }
    // 取消信号与这一步的 admission 一起交下去（C47：相机分支不得丢）。
    const forwarded = await spec.gate.callThrough(exec.agent, name, args.arguments === undefined || args.arguments === null ? {} : args.arguments, exec.signal, exec.toolSet);
    const normalized = normalizeToolResult(forwarded);
    const failed = forwarded !== null && typeof forwarded === "object" && forwarded.isError === true;
    let text = normalized.text;
    if (failed && !/^\s*Error:/.test(text)) text = "Error: " + (text || "目标工具返回 isError");
    return {
      text,
      isError: failed,
      blocks: normalized.contentBlocks,
      truncated: normalized.truncated === true,
    };
  };
}

/** 准入的两种口径：转发（call）比执行口（invoke）多一层 upstream-hidden 的措辞；
 *  canInvoke 是同一个判据——这里只是把「哪句话」也收进处理器参数里。 */
const gateCanInvoke = (gate, exec, name) => verdictOf(gate, exec, name, "invoke");
const gateCanCall = (gate, exec, name) => verdictOf(gate, exec, name, "call");

function verdictOf(gate, exec, name, mode) {
  const verdict = gate.canInvoke(exec.agent, name);
  if (verdict.ok === true) return verdict;
  const label = mode === "invoke" ? "gate_invoke" : "gate_call";
  const message = verdict.reason === "off"
    ? label + ": " + name + " 已被闸门关闭（off），不会转发"
    : verdict.reason === "upstream-hidden"
      ? label + ": " + name + " 被上游隐藏，闸门放不出来"
      : label + ": 未知工具 " + name + (mode === "invoke" ? "（用 gate_search 查准确名字）" : "");
  return { ok: false, message };
}

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
        // 键集与顺序都由 gate.js 的 STATUS_KEYS 决定，这里不再手抄一遍。
        properties: statusSchemaProperties(),
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
      // 快照 → 按唯一清单取子集：工具面不依赖 gate 内部还有没有 status()。
      return pickStatus(gate.snapshot(exec.agent));
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
      // 只读检索口：候选池带 description（从工具真实 description 取首句），技能仍用 skillEntries。
      // 不再从快照的名字数组拼池 —— 那三个数组只有名字，工具搜索结果的说明会恒为空。
      const pool = gate.searchEntries(exec.agent);
      const limit = normalizeSearchLimit(args.limit, 12);
      const hits = searchCatalog(pool, args.query, limit);
      return { results: hits.map((hit) => ({ name: hit.name, description: String(hit.description || "").slice(0, 120), tier: hit.tier })) };
    },
  })));

  disposers.push(options.ctx.tools.register(defineTool({
    name: "gate_load",
    description: "把第二层的工具/技能加载出来。PTC 下工具表冻结：加载后仍用 gate_invoke 执行（声明出现在消息末尾）；native 下加载后下一步可直接调用。传 skill:<名字> 加载技能正文。",
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
          denied: { type: "array", items: { type: "string" } },
          // 段落库存淘汰后的名字：与 unknown 分开（C43：淘汰 ≠ 没找到，模型不该去 gate_search 换名字）。
          evicted: { type: "array", items: { type: "string" } },
          skillText: { type: "string" },
          deltaText: { type: "string" },
          /*
           * 0.5.6 激活回执：tell 真机「信号发给了几个监听者、谁抛错、这次放出/认出什么」。
           * 0.6.0（C35）：activation 保留「最后一条」的兼容视图，receipts 给**逐技能**全量回执
           * （上限 32 条），聚合放行集合进 promoted / promotedTotal。
           */
          activation: ACTIVATION_SCHEMA,
          receipts: {
            type: "array",
            items: ACTIVATION_SCHEMA,
          },
          promoted: { type: "array", items: { type: "string" } },
          promotedTotal: { type: "number" },
        },
      },
      render(args, value) {
        const lines = [];
        if (value.loaded.length > 0) lines.push("已加载: " + value.loaded.join(", ") + "（native 下一步可直接调用；PTC 冻结下用 gate_invoke 执行，工具表不变）");
        if (value.denied && value.denied.length > 0) lines.push("已关闭: " + value.denied.join(", ") + "（off 的工具不会被加载，也不可 gate_invoke；先把它打开）");
        if (value.evicted && value.evicted.length > 0) lines.push("已淘汰: " + value.evicted.join(", ") + "（段落库存已满，名字是对的但正文被回收；先给策略引用或重新装配一次）");
        if (value.unknown.length > 0) lines.push("没找到: " + value.unknown.join(", ") + "（用 gate_search 查准确名字）");
        // 0.4.0 增量投递：签名跟在**本条工具结果**里，而不是下一步的尾部 user 消息。
        // 这样模型在拿到「已加载」的同一个回合就看到参数，尾部只需留一行名字索引。
        if (value.activation) {
          const activation = value.activation;
          // 0.5.7：放行结果必须让模型看得见 —— native 模式下模型只看 render 文本，
          // structured value 里的 activation.promoted 它根本读不到（0.5.6 的同一个坑）。
          if (Array.isArray(activation.promoted) && activation.promoted.length > 0) {
            lines.push("", "技能激活：放出 " + activation.promoted.length + " 个工具（" + activation.promoted.join(", ") + "），下一步起可直接调用或 gate_invoke");
          }
          const relay = activation.relay;
          // 0.6.0（C45）：listeners 为 0 时如实写「没有监听者」，不再说「送到 0/1」。
          if (relay && relay.listeners === 0) {
            lines.push("", "激活信号：当前没有监听者（" + relay.mode + "），本次回执不做投递假定");
          } else if (relay && relay.failed && relay.failed.length > 0) {
            lines.push("", "激活信号：送到 " + relay.delivered + "/" + relay.listeners + " 个监听者（" + relay.mode + "）；失败 " + relay.failed.length + " 个：" + relay.failed.join(" / "));
          }
          const total = typeof value.promotedTotal === "number" ? value.promotedTotal : 0;
          if (Array.isArray(value.promoted) && value.promoted.length > 0 && total > value.promoted.length) {
            lines.push("技能激活合计放出 " + total + " 个工具（回执只列前 " + value.promoted.length + " 个）");
          }
        }
        if (value.deltaText) lines.push("", value.deltaText);
        if (value.skillText) lines.push("", value.skillText);
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(args, exec) {
      const names = Array.isArray(args.names) ? args.names : [];
      const skillNames = names.filter((n) => typeof n === "string" && n.startsWith("skill:")).map((n) => n.slice("skill:".length));
      const toolNames = names.filter((n) => typeof n === "string" && !n.startsWith("skill:"));
      const result = await gate.load(exec.agent, toolNames);
      const loaded = result.loaded.slice();
      const unknown = result.unknown.slice();
      const denied = (result.denied || []).slice();
      const evicted = (result.evicted || []).slice();
      /** @type {string[]} */
      const blocks = [];
      /** 0.6.0：逐技能回执（上限 32 条），不再只留最后一条。 */
      const receipts = [];
      const promoted = [];
      let promotedTotal = 0;
      // C46：一次 gate_load 里的多个技能共享同一份「工具名 / off / resident」解析结果，
      // 族放行只做一次批量过滤（promoteSkillFamily 的 batch 参数）。
      const batch = {};
      // 逃生门：skills.takeover=false 时完整退回 0.1.8 —— 宿主 skill 工具照常可见，
      // gate_load("skill:x") 也照旧转发给它，正文由宿主渲染。
      const takeover = policy.enabled !== false && !(policy.skills && policy.skills.takeover === false);
      for (const skillName of skillNames) {
        if (!takeover) {
          try {
            const forwarded = await gate.callThrough(exec.agent, "skill", { name: skillName });
            const text = normalizeToolResult(forwarded).text;
            if (text) blocks.push(text);
          } catch (error) {
            blocks.push("技能 " + skillName + " 加载失败: " + String((error && error.message) || error));
          }
          continue;
        }
        // 工单 14：接管后不再转发宿主 skill 工具（它已被 deny），正文由 gate 自己解析与渲染。
        // 失败一律走 unknown/denied 语义，不再编一段「加载失败」文本让模型猜。
        const skill = await gate.loadSkill(exec.agent, skillName, exec.signal, batch);
        if (skill.ok) {
          loaded.push("skill:" + skill.name);
          blocks.push(skill.text);
          if (skill.activation) {
            const diagnostic = typeof skill.diagnostic === "string"
              ? skill.diagnostic
              : typeof skill.activation.diagnostic === "string"
                ? skill.activation.diagnostic
                : undefined;
            const receipt = {
              skill: skill.activation.skill,
              conditional: skill.activation.conditional,
              promoted: (skill.activation.promoted || []).slice(0, 32),
              relay: skill.activation.relay,
              ...(diagnostic === undefined ? {} : { diagnostic }),
            };
            if (receipts.length < 32) receipts.push(receipt);
            promotedTotal += typeof skill.activation.promotedTotal === "number"
              ? skill.activation.promotedTotal
              : (skill.activation.promoted || []).length;
            for (const name of skill.activation.promoted || []) {
              if (!promoted.includes(name)) promoted.push(name);
            }
          }
          continue;
        }
        if (skill.reason === "off") { denied.push("skill:" + skillName); continue; }
        if (skill.reason === "evicted") { evicted.push("skill:" + skillName); continue; }
        // P2-9（复核 2026-11-14）：技能在名单里、只是正文这次取不到，不能报成「没找到」——
        // 模型会以为名字写错，跑去 gate_search 换名字。输出键集不变（只有 unknown/denied），
        // 这条名字不进 unknown，改用正文说明真实原因。
        if (skill.reason === "error") {
          blocks.push("技能 " + skillName + " 暂时取不到正文（名字没错，稍后重试或检查宿主/文件）："
            + (skill.message || "未知原因"));
          continue;
        }
        unknown.push("skill:" + skillName);
      }
      // 只有真正被接受的工具才投递签名（技能正文另有通道：skillText）。
      const delta = gate.deltaTextFor(exec.agent, loaded);
      // 0.5.6 兼容视图：最后一条（诊断旧客户端 / 单技能加载时读它）。
      const activation = receipts.length > 0 ? receipts[receipts.length - 1] : undefined;
      return {
        loaded,
        unknown,
        denied,
        evicted,
        skillText: blocks.join("\n\n"),
        deltaText: delta.text,
        ...(activation === undefined ? {} : { activation }),
        receipts,
        promoted: promoted.slice(0, 32),
        promotedTotal,
      };
    },
  })));

  const callSpec = { label: "gate_call", primary: "name", alias: "tool", admission: "call", gate };
  disposers.push(options.ctx.tools.register(defineTool({
    name: "gate_call",
    description: "直接调用一个被闸门隐藏的工具（不必先 gate_load）。参数与目标工具一致；目标工具名写在 name（也接受 tool，二选一）。",
    parameters: {
      // 别名键不是「新增参数语义」，是同一个位置的另一个键名（见 resolveTargetName）。
      // required 一条都不加：现有宿主不接受就不加（本次只加键，不加必填）。
      name: { type: "string", description: "目标工具名（主键；与 tool 等价，二选一）" },
      tool: { type: "string", description: "与 name 等价，二选一（gate_invoke 用这个键名）" },
      arguments: { type: "object", additionalProperties: true, description: "目标工具的参数对象" },
    },
    output: {
      schema: FORWARD_OUTPUT_SCHEMA,
      render(args, value) { return renderForwarded(value); },
    },
    execute: makeForwarder(callSpec),
  })));

  /**
   * PTC 冻结下的执行口（工单 07）：工具集不再随 gate_load 变化，加载过的能力一律从这里走。
   *
   * 护栏（都在闸门这一侧，越界的调用是**程序错误**，所以抛错而不是返回 isError）：
   *  - 闸门工具族一律不可转发（C32：包括 gate_load / gate_search / gate_status 与两个转发口，
   *    否则 gate_invoke 可以自调或递归转发）；错误对象带 code=gate-tool-not-forwardable；
   *  - 目标必须在 known 且非 upstreamHidden（canInvoke，与 gate_load 同一份候选集）；
   *  - 不传 parent / schema：转发走自建 pipeline（source:{}），由宿主管线做参数校验。
   * 宿主侧错误（参数被 defineTool 拒、工具抛错、批量失败）转成 { isError: true } 结果，
   * 原样交回模型 —— 让它看见错误文本，而不是把整轮打断。
   */
  const invokeSpec = { label: "gate_invoke", primary: "tool", alias: "name", admission: "invoke", gate };
  disposers.push(options.ctx.tools.register(defineTool({
    name: "gate_invoke",
    description: "执行一个已加载/被隐藏的工具（PTC 下工具表冻结，加载过的能力都走这里）。arguments 与目标工具的参数一致；参数不对会得到 isError 结果。",
    parameters: {
      // 与 gate_call 同：tool 是主键，name 是别名（见 resolveTargetName）。required 依旧不加。
      tool: { type: "string", description: "目标工具名（主键；与 name 等价，二选一）" },
      name: { type: "string", description: "与 tool 等价，二选一（gate_call 用这个键名）" },
      arguments: { type: "object", additionalProperties: true, description: "目标工具的参数对象" },
    },
    output: {
      schema: FORWARD_OUTPUT_SCHEMA,
      render(args, value) { return renderForwarded(value); },
    },
    execute: makeForwarder(invokeSpec),
  })));

  return () => {
    for (const dispose of disposers.reverse()) {
      try { dispose(); } catch { /* 忽略 */ }
    }
  };
}
