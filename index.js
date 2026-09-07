/*
 *  🛤️ 枢轨 · Switchyard —— 酒馆智能预设路由器
 *  co-authored by ripple, Claude Fable 5.1 & OpenAI Codex
 *
 *  主 AI 在正文最后一行写一个极短标记：<route>nsfw</route> / <route>normal</route>
 *  枢轨读到就把整套酒馆预设切到「当前文体对应的那一套」，场景结束切回原预设。
 *
 *  设计要点（全部有测试钉住）：
 *    · 切换时机：AI 楼落地那一刻（MESSAGE_RECEIVED）。等到 GENERATION_STARTED 再切，酒馆已经在组 prompt。
 *    · 重 roll：GENERATION_STARTED(swipe/regenerate) 时按被 roll 那楼之前的一楼重新校对。
 *    · 状态按聊天存 chat_metadata：原预设、当前模式、切去了哪、锁定。换聊天各回各的。
 *    · 映射：显式行优先（base 精确匹配），再 base="*" 的模板行（{base}·NSFW），都没有就不切并提示。
 *    · 你手动换预设，枢轨认账：新预设成为新的基础、模式回 normal，不会下一楼又给你切回去。
 *    · 只走 getContext().getPresetManager() 的公开方法，精确匹配预设名，绝不模糊匹配。
 */

const SY_NAME = "switchyard";
const SY_VERSION = "0.1.2";
const SY_META_KEY = "switchyard_v1";
const SY_EP_KEY = "switchyard_route_instruction";
const SY_DEFAULTS = {
    enabled: false,
    tags: "route, ipe_mode",                 // 认哪些标签名；多个用逗号分
    rowsJson: "",                            // [{mode, base, target}]；base 为 "*" 时 target 可用 {base} 模板
    notify: true,
    injectPrompt: true,                       // 由插件自动给主 AI 贴入极短路由协议，预设本体无需改
    hideMarkers: true,                        // 只从聊天显示层隐藏标记，不改 msg.mes，路由与回滚仍可读取
    lastBase: ""                             // 全局：最近一次在 normal 下看到的预设名（新聊天没记录时的回落）
};
const SY_DEFAULT_ROWS = [{ mode: "nsfw", base: "*", target: "{base}·NSFW" }];

var syLastSet = null;      // { name, ts } 枢轨自己最近一次选的预设，用来区分「人换的」和「我换的」
var syLog = [];            // 最近几条切换记录（内存）
var syInitialized = false;

/* ---------- 基础 ---------- */
function syCtx() { return SillyTavern.getContext(); }
function syCfg() {
    try {
        var es = syCtx().extensionSettings;
        if (!es[SY_NAME]) es[SY_NAME] = Object.assign({}, SY_DEFAULTS);
        var c = es[SY_NAME];
        for (var k in SY_DEFAULTS) if (!(k in c)) c[k] = SY_DEFAULTS[k];
        return c;
    } catch(e) { return Object.assign({}, SY_DEFAULTS); }
}
function sySave(k, v) {
    try { syCfg()[k] = v; var c = syCtx(); if (typeof c.saveSettingsDebounced === "function") c.saveSettingsDebounced(); } catch(e) {}
}
function syRootDocument() {
    try { if (window.top && window.top.document) return window.top.document; } catch(e) {}
    return document;
}
function syQ(sel) { try { var a = syRootDocument().querySelector(sel); if (a) return a; } catch(e) {} try { return document.querySelector(sel); } catch(e) { return null; } }
function syEsc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function(ch){ return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]; }); }
function syEscRe(s) { return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/* ---------- 标记 ---------- */
function syTagNames() {
    var raw = String(syCfg().tags || "route");
    var out = [];
    raw.split(/[,\s，、]+/).forEach(function(t){ t = String(t || "").trim().replace(/[^\w-]/g, ""); if (t && out.indexOf(t) < 0) out.push(t); });
    return out.length ? out : ["route"];
}
function syReadMarker(text, allowMachineSuffix) {
    var s0 = String(text || ""), last = "", lastIdx = -1;
    var lastEnd = -1;
    syTagNames().forEach(function(t){
        var re = new RegExp("<\\s*" + syEscRe(t) + "\\s*>\\s*([\\w-]+)\\s*<\\s*\\/\\s*" + syEscRe(t) + "\\s*>", "gi"), m;
        while ((m = re.exec(s0)) !== null) { if (m.index > lastIdx) { lastIdx = m.index; lastEnd = re.lastIndex; last = m[1]; } }
    });
    // 新落地正文只认真正位于末尾的标记，正文里引用标签不会误切。
    // 历史校对可放宽：小海螺等扩展可能在消息落地后继续往楼尾追加机器标签。
    if (last && allowMachineSuffix !== true && String(s0.slice(lastEnd)).trim()) return "";
    return last ? last.toLowerCase() : "";
}

/* 只清理渲染后的 DOM，不碰聊天原文；无需另装正则，也不会把历史路由证据删掉。 */
function syHideMarkers(idx) {
    if (syCfg().hideMarkers === false) return false;
    try {
        var d = syRootDocument(), root = null;
        var n = Number(idx);
        if (Number.isFinite(n) && n >= 0) root = d.querySelector('#chat .mes[mesid="' + n + '"] .mes_text');
        if (!root) {
            var all = d.querySelectorAll("#chat .mes .mes_text");
            root = all.length ? all[all.length - 1] : null;
        }
        if (!root) return false;
        syTagNames().forEach(function(t){
            try { root.querySelectorAll(t).forEach(function(el){ el.remove(); }); } catch(eQ) {}
            var re = new RegExp("<\\s*" + syEscRe(t) + "\\s*>\\s*[\\w-]+\\s*<\\s*\\/\\s*" + syEscRe(t) + "\\s*>", "gi");
            var walker = d.createTreeWalker(root, (d.defaultView && d.defaultView.NodeFilter ? d.defaultView.NodeFilter.SHOW_TEXT : 4));
            var nodes = [], node;
            while ((node = walker.nextNode())) nodes.push(node);
            nodes.forEach(function(x){ if (re.test(x.nodeValue || "")) { re.lastIndex = 0; x.nodeValue = String(x.nodeValue || "").replace(re, ""); } re.lastIndex = 0; });
        });
        return true;
    } catch(e) { return false; }
}

/* ---------- 映射 ---------- */
function syRows() {
    var l = null;
    try { l = JSON.parse(String(syCfg().rowsJson || "")); } catch(e) { l = null; }
    if (!Array.isArray(l)) return SY_DEFAULT_ROWS.slice();
    var out = [];
    l.forEach(function(x){ if (x && typeof x === "object") out.push({ mode: String(x.mode || "").trim().toLowerCase(), base: String(x.base || "*").trim(), target: String(x.target || "").trim() }); });
    return out;
}
function syRowsSave(rows) { sySave("rowsJson", JSON.stringify(rows || [])); }
function syKnownModes() {
    var s = {}; syRows().forEach(function(r){ if (r.mode) s[r.mode] = true; }); return Object.keys(s);
}
function syIsKnownMode(m) { return m === "normal" || syKnownModes().indexOf(m) >= 0; }
/* base 在 mode 下该切去哪：显式行 > 模板行 > 空（不切） */
function syResolveTarget(base, mode) {
    var rows = syRows(), all = syAllPresets();
    var cand = "";
    for (var i = 0; i < rows.length; i++) if (rows[i].mode === mode && rows[i].base !== "*" && rows[i].base === base) { cand = rows[i].target; break; }
    if (!cand) for (var j = 0; j < rows.length; j++) if (rows[j].mode === mode && rows[j].base === "*") { cand = rows[j].target.split("{base}").join(base); break; }
    if (!cand) return "";
    return all.indexOf(cand) >= 0 ? cand : "";
}

/* ---------- 酒馆预设管理器 ---------- */
function syPM() { try { var c = syCtx(); return typeof c.getPresetManager === "function" ? c.getPresetManager() : null; } catch(e) { return null; } }
function syCurrentPreset() {
    try { var pm = syPM(); if (pm && typeof pm.getSelectedPresetName === "function") return String(pm.getSelectedPresetName() || ""); } catch(e) {}
    return "";
}
function syAllPresets() {
    try { var pm = syPM(); if (pm && typeof pm.getAllPresets === "function") return (pm.getAllPresets() || []).map(String); } catch(e) {}
    return [];
}
/* 精确匹配，绝不模糊：找不到就返回 false，什么都不动 */
async function sySelectPreset(name) {
    try {
        var pm = syPM(); if (!pm) return false;
        var value = pm.findPreset(name);
        if (value === undefined || value === null || value === "") return false;
        syLastSet = { name: name, ts: Date.now() };
        await Promise.resolve(pm.selectPreset(value));
        if (syCurrentPreset() !== name) { syLastSet = null; return false; }
        return true;
    } catch(e) { syLastSet = null; return false; }
}

/* ---------- 每聊天状态 ---------- */
function syMeta() { try { var c = syCtx(); var m = c.chatMetadata || c.chat_metadata; return (m && typeof m === "object") ? m : null; } catch(e) { return null; } }
function syState() {
    var m = syMeta(); var v = m && m[SY_META_KEY];
    var st = (v && typeof v === "object") ? v : {};
    return { mode: String(st.mode || "normal").toLowerCase(), base: String(st.base || ""), routed: String(st.routed || ""), lock: String(st.lock || ""), floor: Number(st.floor) || 0 };
}
function sySetState(patch) {
    try {
        var m = syMeta(); if (!m) return;
        var st = syState(); for (var k in patch) st[k] = patch[k]; st.updatedAt = Date.now();
        m[SY_META_KEY] = st;
        var c = syCtx(); if (typeof c.saveMetadataDebounced === "function") c.saveMetadataDebounced();
    } catch(e) {}
}
function syFloorNo() { try { return (syCtx().chat || []).length; } catch(e) { return 0; } }

/* ---------- 通知（贴顶居中小卡，同小海螺的做法：不贴底，body 被 transform 时贴底会飞出屏幕） ---------- */
function syNotice(text, kind) {
    try {
        if (syCfg().notify === false) return;
        var d = syRootDocument();
        var host = d.documentElement || d.body;
        var st = d.getElementById("sy-notice-stack");
        if (!st) {
            st = d.createElement("div"); st.id = "sy-notice-stack";
            st.style.cssText = "position:fixed;left:50%;top:22px;width:min(300px,calc(100vw - 24px));display:flex;flex-direction:column;gap:6px;pointer-events:none;margin:0;padding:0";
            try { st.style.setProperty("z-index", "2147483647", "important"); st.style.setProperty("transform", "translateX(-50%) translateZ(0)", "important"); } catch(e) {}
            host.appendChild(st);
        }
        var accent = kind === "warn" ? "#B8756C" : "#7C93A6";
        var card = d.createElement("div");
        card.className = "sy-notice";
        card.style.cssText = "pointer-events:auto;position:relative;border-radius:10px;border:1px solid rgba(140,156,172,.30);border-left:3px solid " + accent
            + ";background:rgba(30,31,36,.94);color:#e2e2e2;-webkit-text-fill-color:#e2e2e2;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;font-size:11.5px;line-height:1.4;padding:7px 9px 6px;box-shadow:0 8px 24px rgba(0,0,0,.4)";
        card.innerHTML = '<div style="display:flex;gap:6px;align-items:flex-start"><span style="flex:none">🛤️</span><div style="flex:1;min-width:0;white-space:pre-wrap;word-break:break-word"></div><button type="button" aria-label="关闭" style="flex:none;border:0;background:transparent;color:inherit;font-size:15px;line-height:1;cursor:pointer;padding:0 2px">×</button></div>';
        card.querySelector("div > div").textContent = text;
        function close(){ try { if (card.parentNode) card.parentNode.removeChild(card); } catch(e) {} }
        card.querySelector("button").addEventListener("click", close);
        st.appendChild(card);
        setTimeout(close, kind === "warn" ? 9000 : 4500);
    } catch(e) {}
}
function syLogPush(line) {
    try { syLog.unshift(new Date().toTimeString().slice(0, 8) + "  " + line); if (syLog.length > 8) syLog.length = 8; syRefreshUI(); } catch(e) {}
    try { console.log("[Switchyard] " + line); } catch(e) {}
}

/* ---------- 核心：把当前聊天带到某个模式 ---------- */
/* wantMode: "normal" 或已知模式名；reason 只用于日志 */
async function syApply(wantMode, reason) {
    if (syCfg().enabled !== true) return { did: "disabled" };
    var st = syState();
    var lock = st.lock;
    var want = lock ? lock : String(wantMode || "").toLowerCase();
    if (!want || !syIsKnownMode(want)) return { did: "ignored", want: want };
    var cur = syCurrentPreset();
    if (!cur) return { did: "no-preset" };

    /* 人手动换过预设：当前预设既不是我切去的，也不是我最近选的 → 认账，新预设成为基础，模式回 normal */
    if (st.mode !== "normal" && st.routed && cur !== st.routed && !(syLastSet && syLastSet.name === cur)) {
        sySetState({ mode: "normal", base: cur, routed: "" });
        sySave("lastBase", cur);
        syLogPush("你手动换到「" + cur + "」，枢轨认账：它成为新的基础预设，模式回 normal（" + reason + "）");
        syNotice("你手动换到「" + cur + "」，枢轨记下它是新的基础预设，模式回 normal。", "warn");
        st = syState();
        if (want !== "normal" && !lock) return { did: "manual-reset" };   // 这一楼的标记不再追着切，等下一次标记
    }

    if (want === "normal") {
        if (st.mode !== "normal") {
            var back = st.base;
            if (back && cur !== back) {
                if (!(await sySelectPreset(back))) { syNotice("想切回「" + back + "」但找不到这个预设了，保持「" + cur + "」。", "warn"); }
            }
            sySetState({ mode: "normal", routed: "", floor: syFloorNo() });
            syLogPush("回 normal：" + cur + " → " + (back || cur) + "（" + reason + "）");
            syNotice("回到「" + (back || cur) + "」", "ok");
            return { did: "restored", to: back };
        }
        if (cur !== st.base) sySetState({ base: cur });
        sySave("lastBase", cur);
        return { did: "noop-normal" };
    }

    /* 目标是某个模式 */
    if (st.mode === want && st.routed && cur === st.routed) return { did: "already", to: cur };
    var base = (st.mode !== "normal" && st.base) ? st.base : cur;      // 模式之间横跳，基础不变
    var target = syResolveTarget(base, want);
    if (!target) {
        syLogPush("「" + base + "」没有配 " + want + " 对应的预设，保持不动（" + reason + "）");
        syNotice("「" + base + "」没有配 " + want + " 对应的预设，这次不切。去枢轨设置里加一行，或按命名约定建一个「" + base + "·NSFW」。", "warn");
        return { did: "no-target", base: base };
    }
    if (cur !== target && !(await sySelectPreset(target))) {
        syNotice("切「" + target + "」失败，保持「" + cur + "」。", "warn");
        return { did: "select-failed", to: target };
    }
    sySetState({ mode: want, base: base, routed: target, floor: syFloorNo() });
    sySave("lastBase", base);
    syLogPush(want + "：" + base + " → " + target + "（" + reason + "）");
    syNotice(base + " → " + target + "（" + want + "）", "ok");
    return { did: "switched", to: target };
}

/* 换聊天：各回各的 */
async function syOnChatChanged() {
    if (syCfg().enabled !== true) return;
    var st = syState(), cur = syCurrentPreset();
    var hadState = !!st.base;
    var fallback = String(syCfg().lastBase || "");
    var target = (st.mode !== "normal" && st.routed) ? st.routed : st.base;
    // 新聊天没有自己的记录：若当前只是上一聊天的路由目标，退回上一基础；
    // 若酒馆已按角色自动选了第三套预设，就认当前这套，不与酒馆抢方向。
    if (!hadState) {
        var inheritedRouted = false;
        if (fallback && cur) {
            syKnownModes().some(function(m){ if (syResolveTarget(fallback, m) === cur) { inheritedRouted = true; return true; } return false; });
        }
        target = inheritedRouted ? fallback : cur;
        if (target) { sySetState({ mode: "normal", base: target, routed: "" }); sySave("lastBase", target); }
    }
    if (target && cur !== target) {
        if (await sySelectPreset(target)) syLogPush("换聊天：" + cur + " → " + target + "（本聊天" + (st.mode !== "normal" ? "在 " + st.mode + " 模式" : "是 normal") + "）");
    }
    syApplyRoutePrompt();
    syRefreshUI();
}

/* 人从酒馆界面换了预设（PRESET_CHANGED / OAI_PRESET_CHANGED_AFTER）：不是我换的就认账 */
function syOnPresetChanged() {
    if (syCfg().enabled !== true) return;
    var cur = syCurrentPreset(); if (!cur) return;
    if (syLastSet && syLastSet.name === cur && Date.now() - syLastSet.ts < 3000) return;   // 是我刚切的
    var st = syState();
    if (st.mode !== "normal") {
        sySetState({ mode: "normal", base: cur, routed: "" });
        syLogPush("你手动换到「" + cur + "」，模式回 normal，它成为新的基础预设");
        syNotice("你手动换到「" + cur + "」，枢轨记下它是新的基础预设，模式回 normal。", "warn");
    } else if (st.base !== cur) {
        sySetState({ base: cur });
    }
    sySave("lastBase", cur);
    syRefreshUI();
}

/* AI 楼落地：读标记，立刻切（下一轮生成前预设就已经换好） */
async function syOnMessageReceived(idx) {
    if (syCfg().enabled !== true) return;
    try {
        var chat = syCtx().chat || [];
        var i = Number(idx);
        var msg = (Number.isFinite(i) && i >= 0) ? chat[i] : null;
        if (!msg) { for (var k = chat.length - 1; k >= 0; k--) { if (chat[k] && !chat[k].is_user && chat[k].is_system !== true) { msg = chat[k]; break; } } }
        if (!msg || msg.is_user || msg.is_system === true) return;
        var mk = syReadMarker(msg.mes, false);
        if (!mk) { syRefreshUI(); return; }                 // 没标记：沿用
        await syApply(mk, "第 " + syFloorNo() + " 楼标记");
        setTimeout(function(){ syHideMarkers(i); }, 0);
        syRefreshUI();
    } catch(e) {}
}

/* 已有 swipe、删楼、编辑楼不会再发 MESSAGE_RECEIVED：从当前活聊天最后一个有效标记重建模式。 */
async function syReconcileFromChat(reason) {
    if (syCfg().enabled !== true) return;
    try {
        var chat = syCtx().chat || [], mode = "normal";
        for (var i = chat.length - 1; i >= 0; i--) {
            var m = chat[i];
            if (!m || m.is_user || m.is_system === true) continue;
            var mk = syReadMarker(m.mes, true);
            if (mk) { mode = mk; break; }
        }
        await syApply(mode, reason || "聊天重新校对");
        syRefreshUI();
    } catch(e) {}
}

/* 重 roll / 重新生成：被 roll 那楼的标记作废，按它之前的一楼校对 */
async function syOnGenerationStarted(type) {
    if (syCfg().enabled !== true) return;
    try {
        var t = String(type || "").toLowerCase();
        var chat = syCtx().chat || [];
        var lastAI = -1;
        for (var k = chat.length - 1; k >= 0; k--) { if (chat[k] && !chat[k].is_user && chat[k].is_system !== true) { lastAI = k; break; } }
        var mode = null;
        if (t === "swipe" || t === "regenerate") {
            var prev = -1;
            for (var j = lastAI - 1; j >= 0; j--) { if (chat[j] && !chat[j].is_user && chat[j].is_system !== true) { var mk = syReadMarker(chat[j].mes, true); if (mk) { mode = mk; break; } prev = j; } }
            if (mode === null) mode = "normal";
            await syApply(mode, "重 roll 按上一楼校对");
            return;
        }
        /* 普通生成：自愈——本该在模式里却不在（比如刷新页面后酒馆恢复了默认预设） */
        var st = syState(), cur = syCurrentPreset();
        if (st.mode !== "normal" && st.routed && cur && cur !== st.routed && !(syLastSet && syLastSet.name === cur)) {
            // 不能确定是人换的还是页面重载：以状态为准但只在当前预设等于基础预设时自愈（人换成第三个预设视为手动）
            if (cur === st.base) { if (await sySelectPreset(st.routed)) syLogPush("自愈：本聊天在 " + st.mode + " 模式，重新切到 " + st.routed); }
            else syOnPresetChanged();
        }
        syApplyRoutePrompt();
    } catch(e) {}
}

/* ---------- 给主 AI 的那几句 ---------- */
function sySnippet() {
    var t = syTagNames()[0] || "route";
    var names = ["normal"].concat(syKnownModes());
    var opts = names.map(function(n){ return "<" + t + ">" + n + "</" + t + ">"; }).join("、");
    return "每轮正文的最后一行，预测下一轮回复应使用的预设模式，并单独输出一个标记：" + opts + "。根据当前情节走向判断：下一轮即将进入或仍处于对应特殊场景时写相应模式；下一轮应回到常规场景时写 normal。必须提前一轮切换，不要等特殊场景已经写出后才标记。标记之外不要解释。";
}

/* 由插件自己贴入最小协议：所有被路由到的预设都能继续报模式，用户无需逐份修改。 */
function syApplyRoutePrompt() {
    try {
        var c = syCtx(); if (typeof c.setExtensionPrompt !== "function") return false;
        var EPT = c.extensionPromptTypes || c.extension_prompt_types || {};
        var EPR = c.extensionPromptRoles || c.extension_prompt_roles || {};
        var pos = EPT.IN_CHAT != null ? EPT.IN_CHAT : 1;
        var role = EPR.SYSTEM != null ? EPR.SYSTEM : 0;
        var text = (syCfg().enabled === true && syCfg().injectPrompt !== false) ? sySnippet() : "";
        c.setExtensionPrompt(SY_EP_KEY, text, pos, 0, false, role);
        return true;
    } catch(e) { return false; }
}

/* ---------- UI（扩展抽屉） ---------- */
function syRowsHTML() {
    var rows = syRows(), all = syAllPresets();
    if (!rows.length) return '<div class="sy-hint">还没有映射。点「新增一行」。</div>';
    var h = "";
    rows.forEach(function(r, i){
        var baseOpts = '<option value="*"' + (r.base === "*" ? " selected" : "") + '>任意预设（模板行）</option>';
        all.forEach(function(n){ baseOpts += '<option value="' + syEsc(n) + '"' + (r.base === n ? " selected" : "") + '>' + syEsc(n) + '</option>'; });
        var tOpts = '<option value="' + syEsc(r.target) + '" selected>' + syEsc(r.target || "（填目标预设名或模板）") + '</option>';
        h += '<div class="sy-row" data-i="' + i + '">'
           + '<div style="display:flex;gap:6px"><input type="text" class="text_pole sy-mode" value="' + syEsc(r.mode) + '" placeholder="模式名，如 nsfw" style="flex:1;min-width:0"><input type="button" class="menu_button sy-del" value="删"></div>'
           + '<label>基础预设</label><select class="text_pole sy-base">' + baseOpts + '</select>'
           + '<label>切到</label><input type="text" class="text_pole sy-target" value="' + syEsc(r.target) + '" placeholder="精确的预设名；模板行可写 {base}·NSFW">'
           + '</div>';
    });
    return h;
}
function syRefreshUI() {
    try {
        var c = syCfg();
        var en = syQ("#sy-enabled"); if (en) en.checked = c.enabled === true;
        var nt = syQ("#sy-notify"); if (nt) nt.checked = c.notify !== false;
        var ip = syQ("#sy-inject"); if (ip) ip.checked = c.injectPrompt !== false;
        var hm = syQ("#sy-hide"); if (hm) hm.checked = c.hideMarkers !== false;
        var tg = syQ("#sy-tags"); if (tg && syRootDocument().activeElement !== tg) tg.value = String(c.tags || "");
        var rows = syQ("#sy-rows"); if (rows && !rows.contains(syRootDocument().activeElement)) rows.innerHTML = syRowsHTML();
        var st = syState(), cur = syCurrentPreset();
        var lock = syQ("#sy-lock");
        if (lock) {
            var h = '<option value="">自动（听标记）</option><option value="normal">锁定 normal</option>';
            syKnownModes().forEach(function(m){ h += '<option value="' + syEsc(m) + '">锁定 ' + syEsc(m) + '</option>'; });
            lock.innerHTML = h; lock.value = st.lock || "";
        }
        var now = syQ("#sy-now");
        if (now) now.textContent = c.enabled !== true ? "枢轨未启用。"
            : "本聊天：模式 " + st.mode + (st.lock ? "（锁定）" : "（自动）") + "　基础预设 " + (st.base || cur || "?") + (st.mode !== "normal" ? "　已切到 " + st.routed : "") + "　当前预设 " + (cur || "?");
        var sn = syQ("#sy-snippet"); if (sn) sn.value = sySnippet();
        var lg = syQ("#sy-log"); if (lg) lg.textContent = syLog.join("\n") || "（还没有切换记录）";
        var pre = syQ("#sy-presets"); if (pre) pre.textContent = "当前 API 的预设：" + (syAllPresets().join(" / ") || "（读不到，先连上 API）");
    } catch(e) {}
}
function syDrawerHTML() {
    return '<div id="switchyard-drawer"><div class="inline-drawer">'
        + '<div class="inline-drawer-toggle inline-drawer-header"><b>🛤️ 枢轨 · Switchyard</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>'
        + '<div class="inline-drawer-content">'
        + '<div style="margin:6px 0"><label><input type="checkbox" id="sy-enabled"> 启用枢轨（按正文标记自动切整套预设）</label></div>'
        + '<div class="sy-hint">主 AI 在正文最后一行写 &lt;route&gt;nsfw&lt;/route&gt;，枢轨读到就把整套酒馆预设切到当前文体对应的那一套；写 normal 切回原预设。没写标记就沿用。切换发生在 AI 楼落地那一刻，下一轮生成前预设已经换好。</div>'
        + '<div style="margin:6px 0"><label><input type="checkbox" id="sy-inject"> 自动给主 AI 贴入极短路由协议（推荐，预设本体不用改）</label></div>'
        + '<div style="margin:6px 0"><label><input type="checkbox" id="sy-hide"> 自动隐藏聊天中的路由标记（只隐藏显示，不改原文）</label></div>'
        + '<label>认哪些标签名（逗号分隔，与小海螺共用就留着 ipe_mode）</label><input type="text" id="sy-tags" class="text_pole" placeholder="route, ipe_mode">'
        + '<div id="sy-presets" class="sy-hint" style="margin-top:6px"></div>'
        + '<label style="margin-top:8px">映射表（显式行优先，模板行 {base} 会替换成当前预设名）</label>'
        + '<div id="sy-rows"></div>'
        + '<div style="margin-top:6px"><input type="button" id="sy-add" class="menu_button" value="新增一行"></div>'
        + '<div class="sy-hint">例：模式 nsfw，基础「任意预设」，切到「{base}·NSFW」= 野渡切野渡·NSFW、佩安切佩安·NSFW。没有对应预设的不切并提示，宁可不换不能换错。</div>'
        + '<label style="margin-top:8px">本聊天手动锁定</label><select id="sy-lock" class="text_pole"></select>'
        + '<div class="sy-hint">锁定后不听标记；改回「自动」继续听。模型判断错了拨这个纠正。</div>'
        + '<div id="sy-now" class="sy-hint" style="margin-top:6px"></div>'
        + '<label style="margin-top:8px">路由协议预览（关闭自动贴入时再手动复制）</label><textarea id="sy-snippet" class="text_pole" rows="3" readonly></textarea>'
        + '<div style="margin:6px 0"><label><input type="checkbox" id="sy-notify"> 切换时在屏幕顶部弹一张小卡</label></div>'
        + '<label>最近切换</label><div id="sy-log" class="sy-log"></div>'
        + '<div class="sy-hint" style="margin-top:8px;text-align:right">by ripple, Claude Fable 5.1 &amp; OpenAI Codex · v' + SY_VERSION + '</div>'
        + '</div></div></div>';
}
function syBindUI() {
    var en = syQ("#sy-enabled"); if (en && !en.__sy) { en.__sy = 1; en.addEventListener("change", function(){ sySave("enabled", !!en.checked); if (en.checked) { var cur = syCurrentPreset(); if (cur) { sySetState({ base: syState().base || cur }); sySave("lastBase", syCfg().lastBase || cur); } } syApplyRoutePrompt(); syRefreshUI(); }); }
    var nt = syQ("#sy-notify"); if (nt && !nt.__sy) { nt.__sy = 1; nt.addEventListener("change", function(){ sySave("notify", !!nt.checked); }); }
    var ip = syQ("#sy-inject"); if (ip && !ip.__sy) { ip.__sy = 1; ip.addEventListener("change", function(){ sySave("injectPrompt", !!ip.checked); syApplyRoutePrompt(); syRefreshUI(); }); }
    var hm = syQ("#sy-hide"); if (hm && !hm.__sy) { hm.__sy = 1; hm.addEventListener("change", function(){ sySave("hideMarkers", !!hm.checked); syRefreshUI(); }); }
    var tg = syQ("#sy-tags"); if (tg && !tg.__sy) { tg.__sy = 1; tg.addEventListener("change", function(){ sySave("tags", String(tg.value || "")); syApplyRoutePrompt(); syRefreshUI(); }); }
    var add = syQ("#sy-add"); if (add && !add.__sy) { add.__sy = 1; add.addEventListener("click", function(){ var r = syRows(); r.push({ mode: "", base: "*", target: "{base}·NSFW" }); syRowsSave(r); syRefreshUI(); }); }
    var lock = syQ("#sy-lock"); if (lock && !lock.__sy) { lock.__sy = 1; lock.addEventListener("change", async function(){
        sySetState({ lock: String(lock.value || "") });
        if (lock.value) await syApply(lock.value, "手动锁定"); syRefreshUI();
    }); }
    var rows = syQ("#sy-rows"); if (rows && !rows.__sy) { rows.__sy = 1;
        function read() { var out = []; rows.querySelectorAll(".sy-row").forEach(function(r){ out.push({ mode: String((r.querySelector(".sy-mode") || {}).value || "").trim().toLowerCase(), base: String((r.querySelector(".sy-base") || {}).value || "*"), target: String((r.querySelector(".sy-target") || {}).value || "").trim() }); }); return out; }
        rows.addEventListener("change", function(){ syRowsSave(read()); syRefreshUI(); });
        rows.addEventListener("click", function(ev){ var b = ev.target && ev.target.closest ? ev.target.closest(".sy-del") : null; if (!b) return; var row = b.closest(".sy-row"); var i = row ? Number(row.getAttribute("data-i")) : -1; var r = syRows(); if (i >= 0 && i < r.length) r.splice(i, 1); syRowsSave(r); syRefreshUI(); });
    }
}
function syMountDrawer() {
    try {
        if (syQ("#switchyard-drawer")) return true;
        var jq = (typeof jQuery !== "undefined") ? jQuery : (window.$ || null);
        var target = jq ? jq("#extensions_settings2") : null;
        if (target && target.length) { target.append(syDrawerHTML()); return true; }
        var el = syQ("#extensions_settings2") || syQ("#extensions_settings");
        if (el) { el.insertAdjacentHTML("beforeend", syDrawerHTML()); return true; }
    } catch(e) {}
    return false;
}

/* ---------- 启动 ---------- */
function syInit() {
    if (syInitialized) return;
    try {
        var c = syCtx();
        syCfg();
        syMountDrawer(); syBindUI(); syApplyRoutePrompt(); syRefreshUI();
        var ev = c.eventSource, T = c.event_types || c.eventTypes || {};
        if (ev && T.MESSAGE_RECEIVED) ev.on(T.MESSAGE_RECEIVED, syOnMessageReceived);
        if (ev && T.CHARACTER_MESSAGE_RENDERED) ev.on(T.CHARACTER_MESSAGE_RENDERED, function(idx){ setTimeout(function(){ syHideMarkers(idx); }, 0); });
        if (ev && T.GENERATION_STARTED) ev.on(T.GENERATION_STARTED, syOnGenerationStarted);
        if (ev && T.CHAT_CHANGED) ev.on(T.CHAT_CHANGED, function(){ setTimeout(function(){ syOnChatChanged(); }, 150); });
        /* 酒馆是在预设已经应用之后才发这两个事件的，直接处理，不用再延时 */
        if (ev && T.PRESET_CHANGED) ev.on(T.PRESET_CHANGED, syOnPresetChanged);
        if (ev && T.OAI_PRESET_CHANGED_AFTER) ev.on(T.OAI_PRESET_CHANGED_AFTER, syOnPresetChanged);
        if (ev && T.MESSAGE_SWIPED) ev.on(T.MESSAGE_SWIPED, function(){ setTimeout(function(){ syReconcileFromChat("切换 swipe 后重新校对"); }, 100); });
        if (ev && T.MESSAGE_DELETED) ev.on(T.MESSAGE_DELETED, function(){ setTimeout(function(){ syReconcileFromChat("删楼后重新校对"); }, 300); });
        if (ev && T.MESSAGE_EDITED) ev.on(T.MESSAGE_EDITED, function(){ setTimeout(function(){ syReconcileFromChat("编辑楼层后重新校对"); }, 100); });
        syInitialized = true;
        console.log("[Switchyard] ✓ 已加载 v" + SY_VERSION);
    } catch(e) { console.error("[Switchyard] 初始化失败:", e); }
}
(function boot(){
    function wait() {
        if (typeof SillyTavern === "undefined" || !SillyTavern.getContext) { setTimeout(wait, 300); return; }
        try {
            var c = SillyTavern.getContext();
            if (c.eventSource && c.event_types && c.event_types.APP_READY) c.eventSource.on(c.event_types.APP_READY, function(){ setTimeout(syInit, 100); });
        } catch(e) {}
        setTimeout(syInit, 1500);
        setTimeout(function(){ try { syMountDrawer(); syBindUI(); syRefreshUI(); } catch(e) {} }, 4000);
    }
    wait();
})();
