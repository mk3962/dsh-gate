/**
 * 限制所有权（D8）—— 一个 agent 身上「当前被限制成什么样」的唯一真源。
 *
 * 0.5.7 之前这里是「单布尔 + 隐式键比较」：谁先结束谁把限制装回，并发两个按需工具时
 * 第一个结束者就把限制重算成「全量 deny」，正在跑的慢工具随即被 deny 掉（C30/C31）。
 *
 * 现在升级成**引用计数 + 待生效目标 + 幂等释放令牌**的租约状态机：
 *
 *   状态：mode = none | limited | passthrough，key（限制成哪一组，去重排序后拼接）、
 *         lift（宿主给的撤销句柄）、deny（真正被藏掉的名字）、applying（正在动限制）。
 *   租约：leases（活跃引用计数）、pendingTarget（窗口内算出的下一个目标，只登记不施加）、
 *         revokedTarget（第一个租约拿走了哪个目标，最后一个释放时恢复）。
 *
 * 事件表（逐行对应用例，改行为前先读）：
 *   acquireLease()          0→1：撤销当前限制并记住被撤销目标，发窗口开信号；>0：计数加一。
 *                           返回幂等 release() 令牌：重复调用不改变计数。
 *   applyRestriction(t)     leases>0：只登记 pendingTarget，不真正施加（窗口内摘除集不变，
 *                           慢工具全程不被 deny）；leases=0 且模式与去重排序后的键相同：不动；
 *                           否则撤旧建新。
 *   release()               >1：计数减一；1→0：落地 pendingTarget（没有则恢复被撤销目标），
 *                           发窗口关信号。
 *   clearRestriction()      leases=0：撤句柄；>0：待生效置空。
 *
 * 防护：宿主施加返回非可撤销句柄（不是函数）时**不记句柄**、状态置无限制，并记诊断
 *   restrict-no-handle（绝不留一个假的 limited 态把后续同样的目标挡在幂等短路外）；
 *   受保护名（options.protectedNames）永远不进 deny —— 撤销限制永远不碰它们。
 *
 * 本模块**没有定时器、没有轮询**（C31/C36）：窗口开/关只发信号，调度由闸门做单次防抖。
 */

/** 三态。 */
export const MODE_NONE = "none";
export const MODE_LIMITED = "limited";
export const MODE_PASSTHROUGH = "passthrough";

const MODES = new Set([MODE_NONE, MODE_LIMITED, MODE_PASSTHROUGH]);

/** 诊断码：宿主给回来的句柄不可撤销（无句柄防护行）。 */
export const DIAG_NO_HANDLE = "restrict-no-handle";
/** 诊断码：宿主拒绝/抛错建立限制（fail-open，下一次同样的目标必须还能重试）。 */
export const DIAG_APPLY_FAILED = "restrict-apply-failed";
/** 诊断码：没有施加手段（没传 restrict 回调）。 */
export const DIAG_NO_PROVIDER = "restrict-no-provider";

/** 诊断样本上限：只留最近一小段给诊断端点读（D20）。 */
const DIAG_CAP = 16;

/** 归一化后的键：去重 + 排序后拼接，与输入顺序/重复无关（键比较的唯一口径）。 */
export function denyKey(deny) {
  const unique = [...new Set((Array.isArray(deny) ? deny : []).map((name) => String(name)))];
  return unique.sort().join("|");
}

/**
 * @param {{
 *   restrict?: (filter: {deny: string[]}) => (() => void),
 *   protectedNames?: Iterable<string> | Set<string>,
 *   logger?: any,
 *   now?: () => number,
 * }} options
 *   restrict = 宿主 scoped tools.restrict；只有真的要限制时才会被调用。
 */
export function createRestriction(options) {
  const opts = options || {};
  const logger = opts.logger;
  const protectedNames = opts.protectedNames instanceof Set
    ? opts.protectedNames
    : new Set(Array.isArray(opts.protectedNames) ? opts.protectedNames : []);
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();

  let mode = MODE_NONE;
  let key;
  let lift;
  let count = 0;
  let applying = false;
  /** 当前真正被藏掉的名字（gate 靠它算「自己藏了谁」，也是上游隐藏判据的输入）。 */
  let deny = [];

  /** 租约。 */
  let leases = 0;
  /** 窗口内算出的下一个目标（只登记）。 */
  let pendingTarget;
  /** 第一个租约拿走的目标（最后一个释放时恢复）。 */
  let revokedTarget;
  let windowOpen = false;

  const openListeners = new Set();
  const closeListeners = new Set();
  const diagnostics = [];

  const note = (code, detail) => {
    const row = { code, at: now(), detail: detail === undefined ? undefined : String(detail) };
    diagnostics.push(row);
    while (diagnostics.length > DIAG_CAP) diagnostics.shift();
    try { logger?.warn?.("dsh-gate: 限制诊断 " + code + (detail === undefined ? "" : " — " + row.detail)); } catch { /* 忽略 */ }
  };

  const emit = (listeners, event) => {
    for (const listener of [...listeners]) {
      try { listener(event); } catch (error) { note("listener-failed", String((error && error.message) || error)); }
    }
  };

  /**
   * 真撤销：调用句柄、清空句柄。返回是否真的撤销了东西。
   * （不叫 release —— 公开面上的 release() 是「释放租约」，同名不同义。）
   */
  const dropHandle = () => {
    if (lift === undefined) return false;
    const handle = lift;
    lift = undefined;
    applying = true;
    try {
      try { handle(); } catch { /* 宿主已撤销 */ }
    } finally {
      applying = false;
    }
    return true;
  };

  /**
   * 目标归一：deny 去重（受保护名排除在外），模式必须合法。
   * 「限制成空集」等于不限制：不留没有句柄的 limited 幽灵态。
   */
  const normalizeTarget = (target) => {
    const raw = target && typeof target === "object" ? target : {};
    const names = [];
    for (const name of Array.isArray(raw.deny) ? raw.deny : []) {
      if (typeof name !== "string" || name.length === 0) continue;
      if (protectedNames.has(name)) continue;   // 受保护名绝不被撤销（也绝不进 deny）
      if (!names.includes(name)) names.push(name);
    }
    names.sort();
    const wanted = MODES.has(raw.mode) ? raw.mode : MODE_NONE;
    if (wanted === MODE_LIMITED && names.length === 0) return { mode: MODE_NONE, key: undefined, deny: [] };
    if (wanted !== MODE_LIMITED) return { mode: wanted, key: undefined, deny: [] };
    return { mode: wanted, key: denyKey(names), deny: names };
  };

  /** 真正施加（只在没有活跃租约时调用）。 */
  const applyNow = (want) => {
    // 幂等：目标模式与键都跟当前一致，就一点动作都不做。
    if (want.mode === mode && want.key === key) return false;
    dropHandle();
    mode = want.mode;
    key = want.key;
    count = 0;
    deny = [];
    if (want.mode !== MODE_LIMITED || want.deny.length === 0) return true;
    if (typeof opts.restrict !== "function") {
      // 没施加手段就不可能真限制：状态必须停在 none —— 留着 limited 的皮，
      // 下一次同样的目标会被幂等短路吃掉，看上去「限制着」其实一个名字都没藏。
      note(DIAG_NO_PROVIDER, want.key);
      mode = MODE_NONE;
      key = undefined;
      count = 0;
      deny = [];
      return true;
    }
    applying = true;
    try {
      const handle = opts.restrict({ deny: want.deny.slice() });
      if (typeof handle !== "function") {
        // 非撤销句柄：不记句柄、状态置无限制，记诊断。留着 limited 的皮会被下一次的
        // 幂等短路永久挡住 —— 看上去「限制着」，其实一个名字都没藏（静默失效）。
        note(DIAG_NO_HANDLE, want.key);
        mode = MODE_NONE;
        key = undefined;
        count = 0;
        deny = [];
        return true;
      }
      lift = handle;
      count = want.deny.length;
      deny = want.deny.slice();
    } catch (error) {
      note(DIAG_APPLY_FAILED, String((error && error.message) || error));
      // 建立失败必须退回「未限制」：留着 limited 的皮，下一次同样的目标会被幂等短路挡住，
      // 这个 agent 就永远不再重试 —— fail-open 是对的，静默失效不是。
      lift = undefined;
      count = 0;
      mode = MODE_NONE;
      key = undefined;
    } finally {
      applying = false;
    }
    return true;
  };

  /** 状态清空（物理撤销 + 三态归 none），不动租约。 */
  const resetState = () => {
    dropHandle();
    mode = MODE_NONE;
    key = undefined;
    count = 0;
    deny = [];
  };

  /**
   * 申请一个租约（C30/C31）。返回**幂等**释放令牌：调用多次只减一次计数。
   * 令牌本身是函数（可直接调 release()），另带只读 released 标志与 id，便于诊断。
   */
  const acquireLease = (meta) => {
    if (leases === 0) {
      revokedTarget = { mode, key, deny: deny.slice() };
      resetState();
      windowOpen = true;
      emit(openListeners, { reason: (meta && meta.reason) || "lease", at: now() });
    }
    leases += 1;
    const id = "lease-" + leases + "-" + diagnostics.length;
    let released = false;
    const token = function release() {
      if (released) return false;       // 令牌幂等：重复释放不改变计数
      released = true;
      if (leases <= 0) return false;
      leases -= 1;
      if (leases > 0) return false;     // 不是最后一个：窗口继续，摘除集不变
      // 最后一个释放：落地待生效目标；没有就恢复被撤销目标。
      const next = pendingTarget !== undefined ? pendingTarget : revokedTarget;
      pendingTarget = undefined;
      revokedTarget = undefined;
      windowOpen = false;
      if (next !== undefined && (next.mode !== MODE_NONE || next.key !== undefined)) applyNow(next);
      else resetState();
      emit(closeListeners, { at: now() });
      return true;
    };
    try { Object.defineProperty(token, "released", { get: () => released, enumerable: true }); } catch { /* 冻结环境忽略 */ }
    try { Object.defineProperty(token, "id", { value: id, enumerable: true }); } catch { /* 忽略 */ }
    return token;
  };

  /**
   * 施加目标。窗口内有活跃租约时**只登记待生效目标**，绝不真正施加 ——
   * 这是 C31 的核心：窗口内重算不会把正在跑的慢工具 deny 掉。
   */
  const apply = (target) => {
    const want = normalizeTarget(target);
    if (leases > 0) {
      pendingTarget = want;
      return;
    }
    applyNow(want);
  };

  /**
   * 主动撤销。窗口内只清待生效目标（不撤当前句柄：当前句柄本来就已经撤销了）。
   * 别名 drop：0.5.7 的调用方（gate.js）继续可用。
   */
  const clearRestriction = () => {
    if (leases > 0) { pendingTarget = undefined; return; }
    resetState();
  };

  /** 兼容别名（0.5.7 公开面）：drop === clearRestriction。 */
  const drop = clearRestriction;

  /**
   * 临时窗口（转发一个被藏起来的工具时用）：申请租约 → 执行 → 释放租约。
   * 并发调用不会互相踩：先结束的那个只是把计数减一，最后一个才恢复限制。
   */
  const suspend = async (fn, meta) => {
    const lease = acquireLease(meta);
    try {
      return await fn();
    } finally {
      lease();
    }
  };

  /** 窗口信号：开 / 关。返回退订函数（卸载时调用，避免残留监听）。 */
  const onWindowOpen = (listener) => {
    if (typeof listener !== "function") return () => {};
    openListeners.add(listener);
    return () => openListeners.delete(listener);
  };
  const onWindowClose = (listener) => {
    if (typeof listener !== "function") return () => {};
    closeListeners.add(listener);
    return () => closeListeners.delete(listener);
  };

  /** 卸载：撤限制、退订全部监听、清租约状态（窗口里的调用由调用方自己收尾）。 */
  const destroy = () => {
    openListeners.clear();
    closeListeners.clear();
    pendingTarget = undefined;
    revokedTarget = undefined;
    leases = 0;
    windowOpen = false;
    resetState();
  };

  return {
    apply,
    // 票 #04 的显式名字（与 apply / drop 同义，逐步迁移后旧名字可删）。
    applyRestriction: apply,
    clearRestriction,
    drop,
    suspend,
    acquireLease,
    onWindowOpen,
    onWindowClose,
    destroy,
    isApplying: () => applying,
    isWindowOpen: () => windowOpen,
    leases: () => leases,
    diagnostics: () => diagnostics.map((row) => ({ ...row })),
    /** 诊断计数（D20：被吞异常进计数，不只有最近样本）。 */
    diagnosticCount: () => diagnostics.length,
    state: () => ({
      mode,
      key,
      count,
      deny: deny.slice(),
      leases,
      windowOpen,
      pending: pendingTarget === undefined ? undefined : { mode: pendingTarget.mode, key: pendingTarget.key, deny: pendingTarget.deny.slice() },
      revoked: revokedTarget === undefined ? undefined : { mode: revokedTarget.mode, key: revokedTarget.key, deny: revokedTarget.deny.slice() },
    }),
  };
}
