/**
 * 技能接管（0.3.0 工单 14，B 案）—— 纯函数 + 一个宿主查询口。
 *
 * 背景（docs/dsh-gate-0.3.0-skill-mcp-接管可行性.md §4）：
 * 宿主没有「关某个技能」的 API（只有 registerProvider/list/snapshot/get）。所以 gate 走 B 案：
 * 自己 deny 宿主的 `skill` 工具（tool-skill 的目录 pre-step 在 TS:936-945 判 `ctx.tools.get("skill",agent) === skillTool`，
 * 不可见即不再生成目录），技能目录与正文全部由 gate 自己出。
 *
 * 本文件只做三件事，全部可单测、不碰宿主状态：
 *   1) 列宿主技能（交给调用方用 ctx.skills.list/snapshot，这里只归一形状）；
 *   2) 扫描 gate.json 里的 skills.imports（SKILL.md 目录 / 多子目录 / 单文件三种形态），
 *      自己解 frontmatter（不加依赖）；
 *   3) 合并成一份「gate 可见技能表」：宿主优先，同名导入标 shadowed 并告警；正文统一
 *      渲染成 <skill_content name="..."> 包装。
 *
 * 宿主返回形状（0.2.2-rc.1 一手核对）：
 *   list({cwd,signal,scope})     → [{name, description, provider, modelInvocable, userInvocable}]
 *   snapshot({cwd,signal,scope}) → {skills, complete}
 *   get(name,{cwd,signal,scope}) → {name, provider, resourceBase, content}
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { firstSentence } from "./catalog.js";
import { resolveService } from "./server.js";
import { normalizeTier, TIER_OFF, TIER_ONDEMAND, TIER_RESIDENT } from "./tiers.js";

export const SKILL_ORIGIN_HOST = "host";
export const SKILL_ORIGIN_IMPORT = "import";

/** 常驻正文单条上限（字符）。超过就截断并告警：系统提示词是要按 token 付费的。 */
export const RESIDENT_SKILL_MAX_CHARS = 12000;

/** 单个技能文件读取上限（字节）。导入目录是本地可信配置，但一个手滑的大文件不该把会话拖垮。 */
export const MAX_SKILL_FILE_BYTES = 1024 * 1024;

/** 导入扫描缓存的条目上限（LRU）：导入目录是「每步都可能扫」的路径，缓存不能无限长。 */
export const SCAN_CACHE_LIMIT = 32;

/** 冷启动预扫描的默认超时（毫秒）：面板一次 GET 不该被宿主的 provider 发现拖住。 */
export const PRESCAN_TIMEOUT_MS = 1500;

/** 技能名文法：宿主是 /\/([a-z0-9]+(?:-[a-z0-9]+)*)/（TS:1102），这里只做本地文件的兜底归一。 */
export function normalizeSkillName(value) {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  const slug = text.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-");
  return slug.length > 0 ? slug : "";
}

/** 由目录 / 文件名推技能名（frontmatter 没写 name 时用）。 */
export function skillNameFromPath(filePath) {
  const base = path.basename(String(filePath || ""));
  const stem = base.toLowerCase() === "skill.md" ? path.basename(path.dirname(filePath)) : base.replace(/\.md$/i, "");
  return normalizeSkillName(stem) || "skill";
}

/**
 * 简易 frontmatter 解析：文件开头 `---` 块里的 `key: value`。
 * 支持单行标量、引号标量，以及 `|` / `>` 块标量（缩进续行）。
 * 不引 yaml 依赖：技能文件只用得到 name / description 这类字段，遇到不认识的写法保持原样而不是乱猜。
 */
export function parseFrontmatter(text) {
  const raw = typeof text === "string" ? text.replace(/^\uFEFF/, "") : "";
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (match === null) return { data: {}, body: raw, hasFrontmatter: false };
  const data = {};
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const cut = trimmed.indexOf(":");
    if (cut <= 0) continue;
    const key = trimmed.slice(0, cut).trim().toLowerCase();
    let value = trimmed.slice(cut + 1).trim();
    // 块标量：| 保留换行，> 折叠成空格；都吃掉后面所有缩进更深的行。
    if (value === "|" || value === ">" || value === "|-" || value === ">-" || value === "|+" || value === ">+") {
      const style = value[0];
      const collected = [];
      index += 1;
      for (; index < lines.length; index += 1) {
        const next = lines[index];
        if (next.trim().length === 0) { collected.push(""); continue; }
        if (!/^\s/.test(next)) { index -= 1; break; }
        collected.push(next.replace(/^\s+/, ""));
      }
      const joined = style === "|" ? collected.join("\n") : collected.join(" ").replace(/\s{2,}/g, " ").trim();
      if (key.length > 0) data[key] = joined;
      continue;
    }
    if (/^".*"$/.test(value) || /^'.*'$/.test(value)) value = value.slice(1, -1);
    if (key.length > 0) data[key] = value;
  }
  return { data, body: raw.slice(match[0].length), hasFrontmatter: true };
}

/** 一条技能的归一形状（宿主与导入都走它，下游只认这一份）。 */
export function makeSkill(entry) {
  const source = entry && typeof entry === "object" ? entry : {};
  const origin = source.origin === SKILL_ORIGIN_IMPORT ? SKILL_ORIGIN_IMPORT : SKILL_ORIGIN_HOST;
  const provider = typeof source.provider === "string" && source.provider.trim().length > 0
    ? source.provider.trim()
    : origin === SKILL_ORIGIN_IMPORT ? "gate-import" : undefined;
  const file = typeof source.path === "string" && source.path.length > 0 ? source.path : undefined;
  return {
    name: String(source.name || ""),
    description: typeof source.description === "string" ? source.description : "",
    provider,
    origin,
    // 导入技能的落点（文件路径）；宿主技能没有路径（正文只能走 ctx.skills.get）。
    path: file,
    content: typeof source.content === "string" ? source.content : undefined,
    // 宿主权限边界（TS:874-879 / 910-912）：模型不可调用的技能不进目录、不可 gate_load；
    // 用户不可调用的技能不接 /name 手势。缺省 true 是宿主对普通技能的默认。
    modelInvocable: source.modelInvocable !== false,
    userInvocable: source.userInvocable !== false,
    shadowed: source.shadowed === true,
    shadowedBy: typeof source.shadowedBy === "string" ? source.shadowedBy : undefined,
  };
}

/**
 * 读一个 SKILL.md / 单文件：frontmatter 出 name/description，正文是块之后的部分。
 * 超过 MAX_SKILL_FILE_BYTES 直接拒读（抛 code=skill-too-large），由调用方记告警 —— 不静默截断正文，
 * 截断的技能正文比「读不到」更危险。
 */
export function readSkillFile(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch (error) { throw error; }
  if (stat.size > MAX_SKILL_FILE_BYTES) {
    const error = new Error("技能文件超过 " + MAX_SKILL_FILE_BYTES + " 字节，拒绝读取：" + filePath);
    error.code = "skill-too-large";
    throw error;
  }
  const text = fs.readFileSync(filePath, "utf8");
  const parsed = parseFrontmatter(text);
  const name = normalizeSkillName(parsed.data.name) || skillNameFromPath(filePath);
  const description = typeof parsed.data.description === "string" ? parsed.data.description.trim() : "";
  return { name, description, content: parsed.body, path: filePath };
}

/** 导入扫描缓存（按解析后路径 + 指纹），带 LRU 上限。 */
const scanCache = new Map();

/** 读缓存：命中时把条目移到队尾（Map 保持插入序 = LRU 序）。 */
function cacheGet(key) {
  const hit = scanCache.get(key);
  if (hit === undefined) return undefined;
  scanCache.delete(key);
  scanCache.set(key, hit);
  return hit;
}

function cacheSet(key, value) {
  scanCache.delete(key);
  scanCache.set(key, value);
  while (scanCache.size > SCAN_CACHE_LIMIT) {
    const oldest = scanCache.keys().next();
    if (oldest.done === true) break;
    scanCache.delete(oldest.value);
  }
}

/** 目录/文件的指纹：只看名字、mtime、size，用来躲开「每一步都重新读全文」。 */
function stampOf(files) {
  const parts = [];
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      parts.push(file + ":" + stat.mtimeMs + ":" + stat.size);
    } catch {
      parts.push(file + ":missing");
    }
  }
  return parts.join("\u0000");
}

/**
 * 目录里有没有 SKILL.md。用 stat（跟随符号链接）而不是 Dirent.isFile()：
 * 导入目录常是 symlink 布局，宿主也宣称支持符号链接技能。
 */
function hasSkillFile(dir) {
  try { return fs.statSync(path.join(dir, "SKILL.md")).isFile(); } catch { return false; }
}

/**
 * 列目录项，并把符号链接解析成它指向的真实类型（防环：最多跟 8 跳）。
 * 读不出来就跳过这一项，不让一个坏链接毁掉整份导入目录。
 */
function dirEntries(dir) {
  let raw;
  try { raw = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const entry of raw) {
    if (!entry.isSymbolicLink()) { out.push(entry); continue; }
    const full = path.join(dir, entry.name);
    try {
      const stat = fs.statSync(full);
      out.push({ name: entry.name, isDirectory: () => stat.isDirectory(), isFile: () => stat.isFile(), isSymbolicLink: () => true });
    } catch { /* 断链：跳过 */ }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * 扫一个导入根，返回候选文件清单：
 *   - 路径是文件           → 它自己；
 *   - 目录含 SKILL.md      → 目录自己算一个技能；
 *   - 目录下多子目录各含 SKILL.md → 每个子目录一个；
 *   - 目录下直接放 *.md     → 每个文件一个（单文件形态）。
 * 只支持一层子目录：再深的布局没有稳定约定，宁可扫不到也不要猜（扫不到会告警）。
 */
export function discoverSkillFiles(rootPath) {
  let stat;
  try { stat = fs.statSync(rootPath); } catch { return { files: [], missing: true }; }
  if (stat.isFile()) return { files: [rootPath], missing: false };
  if (!stat.isDirectory()) return { files: [], missing: true };
  if (hasSkillFile(rootPath)) return { files: [path.join(rootPath, "SKILL.md")], missing: false };
  const files = [];
  const children = dirEntries(rootPath);
  for (const child of children) {
    if (child.isDirectory() && hasSkillFile(path.join(rootPath, child.name))) {
      files.push(path.join(rootPath, child.name, "SKILL.md"));
    }
  }
  if (files.length > 0) return { files, missing: false };
  for (const child of children) {
    if (child.isFile() && /\.md$/i.test(child.name)) files.push(path.join(rootPath, child.name));
  }
  return { files, missing: false };
}

/** 解析一个 import 声明里的路径（~/ 与相对路径都归一到绝对路径）。 */
export function resolveImportPath(importPath, options) {
  const opts = options || {};
  let text = typeof importPath === "string" ? importPath.trim() : "";
  if (text.length === 0) return undefined;
  if (text === "~") text = os.homedir();
  else if (text.startsWith("~/") || text.startsWith("~\\")) text = path.join(os.homedir(), text.slice(2));
  if (path.isAbsolute(text)) return path.normalize(text);
  // 相对路径以策略文件所在目录为基准：同一个 gate.json 挪到哪都能找到自己旁边的技能。
  const base = typeof opts.baseDir === "string" && opts.baseDir.length > 0 ? opts.baseDir : process.cwd();
  return path.normalize(path.join(base, text));
}

/**
 * 扫一个导入根 → 技能数组（含正文）。
 * @returns {{skills: Array<object>, warnings: Array<{code:string,message:string}>}}
 */
export function scanImport(root, options) {
  const opts = options || {};
  const id = normalizeSkillName(opts.id) || "gate-import";
  const resolved = resolveImportPath(root, { baseDir: opts.baseDir });
  const warnings = [];
  if (resolved === undefined) {
    warnings.push({ code: "import-path-empty", message: "技能导入条目缺少 path" });
    return { skills: [], warnings };
  }
  const found = discoverSkillFiles(resolved);
  if (found.missing) {
    warnings.push({ code: "import-missing", message: "技能导入目录不存在：" + resolved });
    return { skills: [], warnings };
  }
  if (found.files.length === 0) {
    warnings.push({ code: "import-empty", message: "技能导入目录里没有 SKILL.md 或 *.md：" + resolved });
    return { skills: [], warnings };
  }
  const stamp = stampOf(found.files);
  const cached = cacheGet(resolved);
  if (cached !== undefined && cached.stamp === stamp && cached.id === id) {
    return { skills: cached.skills.map((skill) => ({ ...skill })), warnings: cached.warnings.map((w) => ({ ...w })) };
  }
  const skills = [];
  for (const file of found.files) {
    try {
      const read = readSkillFile(file);
      skills.push(makeSkill({
        name: read.name,
        description: read.description,
        provider: id,
        origin: SKILL_ORIGIN_IMPORT,
        path: file,
        content: read.content,
      }));
    } catch (error) {
      warnings.push({ code: "import-unreadable", message: "技能文件读取失败：" + file + " — " + String((error && error.message) || error) });
    }
  }
  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  cacheSet(resolved, { stamp, id, skills: skills.map((skill) => ({ ...skill })), warnings: warnings.map((w) => ({ ...w })) });
  return { skills, warnings };
}

/** 扫全部 import 声明；条目顺序就是优先级（先声明的赢），同名后者标 shadowed。 */
export function scanImports(imports, options) {
  const opts = options || {};
  const skills = [];
  const warnings = [];
  const seen = new Set();
  for (const item of Array.isArray(imports) ? imports : []) {
    if (!item || typeof item !== "object") continue;
    const result = scanImport(item.path, { id: item.id, baseDir: opts.baseDir });
    for (const warning of result.warnings) warnings.push(warning);
    for (const skill of result.skills) {
      if (seen.has(skill.name)) {
        skills.push({ ...skill, shadowed: true, shadowedBy: "import" });
        warnings.push({ code: "skill-shadowed", message: "导入技能同名，已标记 shadowed（只保留先声明的那份）：" + skill.name });
        continue;
      }
      seen.add(skill.name);
      skills.push(skill);
    }
  }
  return { skills, warnings };
}

/**
 * 合并宿主技能与导入技能：**宿主优先**（同名导入标 shadowed 并告警）。
 * shadowed 的条目仍留在表里（/capabilities 要能说明「它被谁遮了」），但不算 gate 可见技能。
 */
export function mergeSkills(hostSkills, importedSkills) {
  const warnings = [];
  const out = [];
  const hostNames = new Set();
  for (const item of Array.isArray(hostSkills) ? hostSkills : []) {
    const skill = makeSkill({ ...item, origin: SKILL_ORIGIN_HOST });
    if (skill.name.length === 0) continue;
    if (hostNames.has(skill.name)) continue; // 宿主自己的重名（理论上按层去重过）：先到的赢
    hostNames.add(skill.name);
    out.push(skill);
  }
  for (const item of Array.isArray(importedSkills) ? importedSkills : []) {
    const skill = makeSkill({ ...item, origin: SKILL_ORIGIN_IMPORT });
    if (skill.name.length === 0) continue;
    if (hostNames.has(skill.name)) {
      out.push({ ...skill, shadowed: true, shadowedBy: "host" });
      warnings.push({ code: "skill-shadowed", message: "导入技能与宿主技能同名，宿主优先：" + skill.name });
      continue;
    }
    if (out.some((row) => row.origin === SKILL_ORIGIN_IMPORT && row.name === skill.name)) {
      out.push({ ...skill, shadowed: true, shadowedBy: "import" });
      warnings.push({ code: "skill-shadowed", message: "导入技能同名，只保留先声明的那份：" + skill.name });
      continue;
    }
    out.push(skill);
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { skills: out, warnings };
}

/** 正文统一的包装（宿主 renderSkillContent 的等价物；导入技能也走这一份）。 */
export function renderSkillContent(skill) {
  const name = String((skill && skill.name) || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const body = String((skill && skill.content) || "").replace(/\r\n/g, "\n").replace(/\s+$/u, "");
  return '<skill_content name="' + name + '">\n' + (body.length > 0 ? body : "（这份技能没有正文。）") + "\n</skill_content>";
}

/**
 * gate 自己注入的段落名前缀。sections.js 用它把这批段落排除在「可摘除段落」之外：
 * 它们不是宿主段落，没有档位可配，也不该出现在 UI 的段落清单里被用户误摘。
 */
export const GATE_SKILL_SECTION_PREFIX = "gate-skill:";

export function isGateSkillSection(name) {
  return typeof name === "string" && name.startsWith(GATE_SKILL_SECTION_PREFIX);
}

/**
 * 常驻技能正文 → 系统提示词段落（工单 14 第 7 条：独立段落、不进 gate-catalog）。
 * 逐字节稳定：同样的技能表 + 同样上限 → 同样的文本（没有时间戳/序号）。
 * 单条超过上限就截断并告警（正文太长会挤爆系统提示词，而 gate_load 随时能取全文）。
 */
export function residentSkillSections(skills, options) {
  const opts = options || {};
  const limit = Number.isFinite(opts.maxChars) && opts.maxChars > 0 ? Math.floor(opts.maxChars) : RESIDENT_SKILL_MAX_CHARS;
  const sections = [];
  const warnings = [];
  for (const skill of Array.isArray(skills) ? skills : []) {
    if (!skill || typeof skill.name !== "string" || skill.name.length === 0) continue;
    const full = renderSkillContent(skill);
    if (full.length <= limit) {
      sections.push({ name: GATE_SKILL_SECTION_PREFIX + skill.name, text: full, interpolate: false });
      continue;
    }
    const marker = "\n\n（正文共 " + full.length + " 字，只注入前 " + limit + " 字；要全文请 gate_load(\"skill:" + skill.name + "\")。）";
    sections.push({ name: GATE_SKILL_SECTION_PREFIX + skill.name, text: full.slice(0, limit) + marker, interpolate: false });
    warnings.push({ code: "skill-too-long", message: "常驻技能正文超过 " + limit + " 字，已截断：" + skill.name });
  }
  return { sections, warnings };
}

/** 技能行的目录文本（"宿主:provider" / "导入:id"），gate-catalog 与 /capabilities 共用一份口径。 */
export function skillSourceLabel(skill) {
  const item = skill || {};
  if (item.origin === SKILL_ORIGIN_IMPORT) return "导入:" + (item.provider || "gate-import");
  return item.provider ? "宿主:" + item.provider : "宿主";
}

/** gate-catalog 的一行：名字 + 描述首句 + 来源（按需档才列）。 */
export function skillCatalogEntry(skill, limit) {
  return {
    name: skill.name,
    description: firstSentence(skill.description, limit),
    source: skillSourceLabel(skill),
  };
}

/**
 * 宿主查询口：lookup 形状是 {cwd, signal, scope}（TS:869-873）。
 * 拿不到 skills / workingDirectory 服务时返回 undefined，调用方按「没有宿主技能」处理（fail-soft）。
 */
export async function hostSkillLookup(ctx, agent, signal) {
  const workingDirectory = resolveService(ctx, "workingDirectory");
  let cwd;
  try {
    cwd = workingDirectory && typeof workingDirectory.ensure === "function"
      ? await workingDirectory.ensure(agent, signal)
      : undefined;
  } catch { cwd = undefined; }
  return { cwd, signal, scope: agent };
}

/** 列宿主技能（摘要）。宿主服务缺失 / 抛错一律返回 undefined（不把宿主故障当空名单）。 */
export async function listHostSkills(ctx, agent, signal) {
  const service = resolveService(ctx, "skills");
  if (service === undefined || typeof service.list !== "function") return undefined;
  try {
    const list = await service.list(await hostSkillLookup(ctx, agent, signal));
    return Array.isArray(list) ? list : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 列宿主技能并带上「这份名单是否完整」（宿主 snapshot 的 complete 标志）。
 *
 * 为什么要 complete：宿主 provider 发现超时/被 abort 时会返回一份**部分**名单。
 * 直接拿它覆盖 last-good，会让技能先在目录里消失、下一步又回来 —— 两次改字节 = 两次断缓存，
 * 而且常驻正文会凭空消失一轮。宿主自己的目录注入在 !complete 时干脆不动（TS:945），这里同口径。
 *
 * @returns {Promise<{skills:Array<object>, complete:boolean}|undefined>} 服务缺失/抛错返回 undefined
 */
export async function snapshotHostSkills(ctx, agent, signal) {
  const service = resolveService(ctx, "skills");
  if (service === undefined) return undefined;
  const lookup = await hostSkillLookup(ctx, agent, signal);
  if (typeof service.snapshot === "function") {
    try {
      const snapshot = await service.snapshot(lookup);
      if (snapshot && Array.isArray(snapshot.skills)) {
        return { skills: snapshot.skills, complete: snapshot.complete !== false };
      }
      if (Array.isArray(snapshot)) return { skills: snapshot, complete: true };
    } catch { /* 旧宿主 / 快照抛错：退回 list */ }
  }
  const list = await listHostSkills(ctx, agent, signal);
  if (list === undefined) return undefined;
  return { skills: list, complete: true };
}

/** 预扫描失败的短原因（给 UI 的 prescan.reason；不把整段堆栈灌进去）。 */
function prescanReason(error) {
  if (error === null || error === undefined) return "unknown";
  if (typeof error === "object") {
    if (error.name === "TimeoutError") return "timeout";
    if (error.name === "AbortError") return "aborted";
    if (typeof error.message === "string" && error.message.length > 0) return error.message.slice(0, 200);
  }
  return String(error).slice(0, 200);
}

/**
 * 冷启动预扫描：会话还没装配时，直接从宿主 registry 列一份「当前可见」的技能。
 *
 * 与 listHostSkills / snapshotHostSkills 的区别：这里**没有 agent**，靠默认 preset 的 standing scope 选层
 * （取证见 .scratch/dsh-gate-panel-ui-0.5.0/research/02-cold-start-skills.md §5.1）：
 *   - scope：ctx.get("agentPresets").acquireScope(preset ?? 默认) 的 {key}；拿不到就退回无 scope 读并标 scoped:false
 *     （此时 ~/.dsh/skills 可能被 global 层的第二实例认领，provider 名会不一样）；
 *   - cwd：默认 undefined —— 别猜工作区根，cwd 只多出 <project>/.dsh/skills 与 .agents/skills（笔记 §1.2）；
 *   - 只读：不写文件、不进 gate 状态；租约在 finally 里释放（宿主 acquireScope 只 +1 引用，不重 mount）。
 *
 * 任何失败都返回 {ok:false, reason}（fail-soft）：**服务缺失 ≠ 没有技能**，调用方别把它当空名单。
 *
 * @param {object} ctx 插件 ctx
 * @param {{preset?:string, cwd?:string, signal?:AbortSignal, timeoutMs?:number}} [options]
 * @returns {Promise<{ok:true, scoped:boolean, preset?:string, cwd?:string, complete:boolean, skills:Array<object>}
 *   | {ok:false, reason:string}>}
 */
export async function prescanHostSkills(ctx, options = {}) {
  const opts = options !== null && typeof options === "object" ? options : {};
  const service = resolveService(ctx, "skills");
  if (service === undefined || (typeof service.snapshot !== "function" && typeof service.list !== "function")) {
    return { ok: false, reason: "no-skills-service" };
  }
  let preset = typeof opts.preset === "string" && opts.preset.trim().length > 0 ? opts.preset.trim() : undefined;
  const cwd = typeof opts.cwd === "string" && opts.cwd.trim().length > 0 ? opts.cwd : undefined;
  let lease;
  let scope;
  let scoped = false;
  // 1) preset 的 standing scope：providers 在 preset 组合注册时就挂好了，acquireScope 只是 +1 引用。
  const presets = resolveService(ctx, "agentPresets");
  if (presets !== undefined && typeof presets.acquireScope === "function") {
    try {
      if (preset === undefined && typeof presets.defaultId === "string" && presets.defaultId.length > 0) preset = presets.defaultId;
    } catch { /* defaultId 读不出来就交给 acquireScope(undefined)，宿主自己取默认 */ }
    try {
      lease = await presets.acquireScope(preset);
      if (lease !== undefined && lease !== null && lease.key !== undefined && lease.key !== null) {
        scope = lease.key;
        scoped = true;
      }
    } catch {
      // 未知 preset / 组合 broken：退回无 scope 读，但**不要**因此判定预扫描失败。
      lease = undefined;
      scope = undefined;
      scoped = false;
    }
  }
  // 2) 超时：调用方给了就用调用方的，否则 1500ms 兜底；AbortSignal.timeout 不存在就交给宿主自己 settle。
  let signal = opts.signal;
  if (signal === undefined || signal === null) {
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : PRESCAN_TIMEOUT_MS;
    try {
      if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") signal = AbortSignal.timeout(timeoutMs);
    } catch { signal = undefined; }
  }
  try {
    const request = { cwd, signal, scope };
    let snapshot;
    if (typeof service.snapshot === "function") {
      snapshot = await service.snapshot(request);
    } else {
      // 老宿主只有 list：拿不到 complete 标志，按完整处理（与 snapshotHostSkills 同口径）。
      snapshot = { skills: await service.list(request), complete: true };
    }
    const raw = Array.isArray(snapshot) ? snapshot : snapshot && Array.isArray(snapshot.skills) ? snapshot.skills : undefined;
    if (raw === undefined) return { ok: false, reason: "bad-snapshot" };
    const complete = Array.isArray(snapshot) ? true : snapshot.complete !== false;
    const skills = [];
    for (const item of raw) {
      if (item === null || typeof item !== "object" || typeof item.name !== "string" || item.name.length === 0) continue;
      // 新宿主（0.2.2-rc.3）把权限放在 invocation.{…}；老宿主（rc.1 及更早）是扁平字段。
      // 两种都要认：只读 invocation 会让老宿主的「模型不可调用」技能漏进目录。
      const source = item.invocation !== null && typeof item.invocation === "object"
        ? item.invocation
        : { modelInvocable: item.modelInvocable, userInvocable: item.userInvocable };
      // 宿主技能目录只含模型可调用的技能（笔记 §3 差集）：预扫描同口径，不把隐藏技能列出来。
      if (source.modelInvocable === false) continue;
      skills.push(makeSkill({
        name: item.name,
        description: typeof item.description === "string" ? item.description : "",
        provider: typeof item.provider === "string" ? item.provider : undefined,
        path: typeof item.path === "string" ? item.path : undefined,
        origin: SKILL_ORIGIN_HOST,
        // makeSkill 读**扁平**字段，这里显式映射（新宿主读 invocation，老宿主读扁平字段）。
        modelInvocable: source.modelInvocable !== false,
        userInvocable: source.userInvocable !== false,
      }));
    }
    skills.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    return { ok: true, scoped, preset, cwd, complete, skills };
  } catch (error) {
    // 超时 / abort / provider 抛错：不写缓存，调用方下次 GET 值得重试。
    return { ok: false, reason: prescanReason(error) };
  } finally {
    // 3) 释放租约：engines node>=20，不能用 await using 语法糖，显式特性探测。
    if (lease !== undefined && lease !== null) {
      try {
        const disposeSymbol = typeof Symbol === "function" ? Symbol.asyncDispose : undefined;
        const dispose = disposeSymbol === undefined ? undefined : lease[disposeSymbol];
        if (typeof dispose === "function") await dispose.call(lease);
      } catch { /* 释放失败不影响这份只读结果 */ }
    }
  }
}

/** 取宿主技能正文（{name,provider,resourceBase,content}）；未知技能返回 undefined。 */
export async function getHostSkill(ctx, agent, name, signal) {
  const service = resolveService(ctx, "skills");
  if (service === undefined || typeof service.get !== "function") return undefined;
  try {
    return await service.get(name, await hostSkillLookup(ctx, agent, signal));
  } catch {
    return undefined;
  }
}

/** 一条技能此刻的档位（0 关 / 1 常驻 / 2 按需），供目录/正文/加载三处共用。 */
export function tierOfSkill(decision) {
  return normalizeTier(decision && decision.tier, TIER_ONDEMAND);
}

export { TIER_OFF, TIER_ONDEMAND, TIER_RESIDENT };
