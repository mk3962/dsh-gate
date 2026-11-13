/**
 * 限制所有权（票 02）—— 一个 agent 身上「当前被限制成什么样」的唯一真源。
 *
 * 收口前，这份状态散成四个字段（lift / denyKey / denyCount / applying），
 * 由调用方各自比较「键相同 且 有句柄（或 deny 为空）」来决定是否短路。
 * 那个隐式判据在「收窄豁免」分支上是错的：分支只写了键没写句柄，
 * 于是短路恒假，每次重算都重新走一遍 applying → tools/change 事件被吞 → 白算。
 *
 * 现在改成显式三态 + 显式键比较，全部在对象内部完成：
 *   none         没有被限制（没有撤销句柄，没有键）
 *   limited      被限制成 deny 这一组名字（有撤销句柄，键 = 排序后的 deny 拼接）
 *   passthrough  收窄豁免（按策略本该限制，但工具面太窄，跳过；没有句柄，没有键）
 *
 * 四个动作：
 *   apply(target)  把当前状态变成 target 描述的样子；模式与键都相同就什么都不做（幂等）。
 *   drop()         撤销当前限制（幂等），回到 none。
 *   isApplying()   此刻是否正在动限制（此时 tools/change 是自己引起的，别跟着重算）。
 *   state()        { mode, key, count } 只读快照。
 *
 * 另有 suspend(fn)：把一段执行包进「先真撤销、期间 applying 为 true、结束时恢复 applying」
 * 的临时窗口，专供 gate_call 透传（被藏起来的工具要先放出来才能执行）。它不是状态机的
 * 一部分：窗口结束时状态是 none，由调用方 reapply 重新算出目标并 apply。
 */

/** 三态。 */
export const MODE_NONE = "none";
export const MODE_LIMITED = "limited";
export const MODE_PASSTHROUGH = "passthrough";

const MODES = new Set([MODE_NONE, MODE_LIMITED, MODE_PASSTHROUGH]);

/** 归一化后的键：排序后拼接，与输入顺序无关。 */
export function denyKey(deny) {
  return (Array.isArray(deny) ? deny : []).slice().sort().join("|");
}

/**
 * @param {{restrict?: (filter: {deny: string[]}) => () => void, logger?: any}} options
 *   restrict = 宿主 scoped tools.restrict；只有真的要限制时才会被调用。
 */
export function createRestriction(options) {
  const opts = options || {};
  const logger = opts.logger;

  let mode = MODE_NONE;
  let key;
  let lift;
  let count = 0;
  let applying = false;
  // 当前真正被藏掉的名字（0.2.0）：gate 靠它区分「上游已隐藏」与「自己藏」。
  let deny = [];

  /** 真撤销：调用句柄、清空句柄。返回是否真的撤销了东西。
   *  （不叫 release —— gate 公开面那个 release(agent) 是「释放 agent」，同名不同义。） */
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

  const normalizeTarget = (target) => {
    const raw = target && typeof target === "object" ? target : {};
    const deny = Array.isArray(raw.deny)
      ? raw.deny.map((name) => String(name)).filter((name) => name.length > 0)
      : [];
    const wanted = MODES.has(raw.mode) ? raw.mode : MODE_NONE;
    // 「限制成空集」等于不限制：不要留下一个没有句柄的 limited 幽灵态。
    if (wanted === MODE_LIMITED && deny.length === 0) return { mode: MODE_NONE, key: undefined, deny };
    // 只有「已限制」态有键：标记的是「限制成哪一组」。无限制与豁免都没有句柄，
    // 也就不该留键 —— 留着只是一个没人读的残影（旧实现正是留着它却不用，才短路恒假）。
    if (wanted !== MODE_LIMITED) return { mode: wanted, key: undefined, deny };
    return { mode: wanted, key: denyKey(deny), deny };
  };

  const apply = (target) => {
    const want = normalizeTarget(target);
    // 幂等：目标模式与键都跟当前一致，就一点动作都不做。
    if (want.mode === mode && want.key === key) return;
    dropHandle();
    mode = want.mode;
    key = want.key;
    count = 0;
    deny = [];
    if (want.mode !== MODE_LIMITED || want.deny.length === 0) return;
    if (typeof opts.restrict !== "function") {
      // 没有施加手段就不可能真限制：跟建立失败一样退回未限制。留着 limited 的皮会被
      // 下一次的幂等短路永久挡住，看上去「限制着」其实一个名字都没藏（静默失效）。
      mode = MODE_NONE;
      key = undefined;
      return;
    }
    applying = true;
    try {
      lift = opts.restrict({ deny: want.deny });
      count = want.deny.length;
      deny = want.deny.slice();
    } catch (error) {
      logger?.warn?.("dsh-gate: 建立工具限制失败 — " + String((error && error.message) || error));
      // 建立失败必须退回「未限制」，不能留着 limited 的皮：留着的话下一次同样的目标
      // 会被幂等短路挡住，于是这个 agent 永远不再重试 —— 闸门静默失效（fail-open 是
      // 对的，静默失效不是）。
      lift = undefined;
      count = 0;
      mode = MODE_NONE;
      key = undefined;
    } finally {
      applying = false;
    }
  };

  const drop = () => {
    dropHandle();
    mode = MODE_NONE;
    key = undefined;
    count = 0;
    deny = [];
  };

  /** 临时窗口：先真撤销，期间 applying 为 true，结束后恢复 false（状态停在 none）。 */
  const suspend = async (fn) => {
    drop();
    applying = true;
    try {
      return await fn();
    } finally {
      applying = false;
    }
  };

  return {
    apply,
    drop,
    suspend,
    isApplying: () => applying,
    state: () => ({ mode, key, count, deny: deny.slice() }),
  };
}
