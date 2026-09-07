/* 🛤️ 枢轨 · Switchyard —— jsdom 流程测试
   跑法：node switchyard.test.js
   不碰真酒馆：用一个假的预设管理器（精确匹配、异步选择）和假事件源，钉死切换时机与状态生命周期。 */
const fs = require("fs"), path = require("path");
const { JSDOM } = require("jsdom");
const SRC = fs.readFileSync(path.join(__dirname, "index.js"), "utf8");
let pass = 0, fail = 0;
function ok(c, name, extra) { if (c) { pass++; console.log("  ✅ " + name); } else { fail++; console.log("  ❌ " + name + (extra ? "\n       " + extra : "")); } }
function eq(a, b, name) { ok(a === b, name, "期望 " + JSON.stringify(b) + "，实际 " + JSON.stringify(a)); }

function fakePM(names, opts) {
  opts = opts || {};
  const st = { names: names.slice(), sel: 0, history: [] };
  return {
    _st: st,
    getSelectedPresetName() { return st.names[st.sel]; },
    getAllPresets() { return st.names.slice(); },
    findPreset(name) { const i = st.names.indexOf(name); return i < 0 ? undefined : String(i); },
    async selectPreset(v) {
      if (opts.selectDelay) await new Promise(r => setTimeout(r, opts.selectDelay));
      if (opts.selectFail) throw new Error("select failed");
      st.sel = Number(v); st.history.push(st.names[st.sel]);
    }
  };
}
function boot(opts) {
  opts = opts || {};
  const dom = new JSDOM('<!DOCTYPE html><body><div id="extensions_settings2"></div><div id="chat"></div></body>', { runScripts: "outside-only", url: "http://localhost" });
  const w = dom.window;
  const listeners = {};
  const eventSource = { on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); }, async emit(ev, ...a) { for (const fn of (listeners[ev] || [])) await fn(...a); } };
  const pm = fakePM(opts.presets || ["野渡", "野渡·NSFW", "佩安", "佩安·NSFW", "酒神颂"], opts);
  const chats = { A: { chat: [], meta: {} }, B: { chat: [], meta: {} } };
  let cur = "A";
  const extensionPrompts = {};
  const ctx = {
    get chat() { return chats[cur].chat; },
    get chatMetadata() { return chats[cur].meta; },
    eventSource, event_types: { MESSAGE_RECEIVED: "message_received", CHARACTER_MESSAGE_RENDERED: "character_message_rendered", GENERATION_STARTED: "generation_started", CHAT_CHANGED: "chat_id_changed", PRESET_CHANGED: "preset_changed", OAI_PRESET_CHANGED_AFTER: "oai_preset_changed_after", MESSAGE_SWIPED: "message_swiped", MESSAGE_DELETED: "message_deleted", MESSAGE_EDITED: "message_edited", APP_READY: "app_ready" },
    extensionSettings: {}, extensionPromptTypes: { IN_CHAT: 1 }, extensionPromptRoles: { SYSTEM: 0 },
    saveSettingsDebounced() {}, saveMetadataDebounced() {}, mainApi: "openai",
    setExtensionPrompt(key, value, position, depth, scan, role) { extensionPrompts[key] = { value, position, depth, role }; },
    getPresetManager() { return pm; }
  };
  w.SillyTavern = { getContext: () => ctx };
  const exposed = ["syInit", "syApply", "syReadMarker", "syHideMarkers", "syResolveTarget", "syState", "syCfg", "syOnMessageReceived", "syOnGenerationStarted", "syOnChatChanged", "syOnPresetChanged", "syReconcileFromChat", "syApplyRoutePrompt", "sySnippet", "syCurrentPreset", "syRefreshUI"];
  w.eval(SRC + "\n;(function(){ " + exposed.map(n => `try{ window.__t_${n} = ${n}; }catch(e){}`).join(" ") + " })();");
  const F = n => w["__t_" + n];
  F("syInit")();
  const cfg = F("syCfg")();
  cfg.enabled = true; cfg.notify = false;
  F("syRefreshUI")();
  const ai = (text, chatKey) => { const c = chats[chatKey || cur].chat; c.push({ is_user: true, mes: "user" }); c.push({ is_user: false, mes: text }); return c.length - 1; };
  return { w, ctx, pm, cfg, F, chats, extensionPrompts, switchChat: k => { cur = k; }, ai, fire: (ev, ...a) => eventSource.emit(ev, ...a) };
}

(async () => {
console.log("\n【1】 标记解析：多标签名、取最后一个、大小写不敏感");
{
  const { F, cfg } = boot();
  const P = F("syReadMarker");
  eq(P("正文\n<route>nsfw</route>"), "nsfw", "route 标签");
  eq(P("正文\n<ipe_mode>NSFW</ipe_mode>"), "nsfw", "默认也认 ipe_mode，大小写不敏感");
  eq(P("<route>nsfw</route> 后面 <ipe_mode>normal</ipe_mode>"), "normal", "多个取位置最后的");
  eq(P("正文引用 <route>nsfw</route> 但后面还有正文"), "", "正文中引用标签不误切");
  eq(P("正文\n<route>nsfw</route>\nimage###later###", true), "nsfw", "历史校对允许机器扩展在标签后追加内容");
  eq(P("没有"), "", "没标记为空");
  cfg.tags = "scene";
  eq(P("<route>nsfw</route>"), "", "标签名改成 scene 后 route 不认"); eq(P("<scene>nsfw</scene>"), "nsfw", "scene 认");
}

console.log("\n【2】 映射解析：显式行优先、模板行兜底、目标不存在不切");
{
  const { F, cfg } = boot();
  cfg.rowsJson = JSON.stringify([{ mode: "nsfw", base: "野渡", target: "酒神颂" }, { mode: "nsfw", base: "*", target: "{base}·NSFW" }]);
  eq(F("syResolveTarget")("野渡", "nsfw"), "酒神颂", "显式行优先于模板行");
  eq(F("syResolveTarget")("佩安", "nsfw"), "佩安·NSFW", "模板行 {base} 替换");
  eq(F("syResolveTarget")("酒神颂", "nsfw"), "", "酒神颂·NSFW 不存在 → 空，不切");
  eq(F("syResolveTarget")("野渡", "battle"), "", "没配的模式 → 空");
}

console.log("\n【3】 主流程：AI 楼落地读标记切过去；没标记沿用；normal 切回原预设");
{
  const { F, pm, ai, fire, ctx } = boot();
  eq(F("syCurrentPreset")(), "野渡", "起始预设野渡");
  let i = ai("第一楼，进入。\n<route>nsfw</route>");
  await fire("message_received", i);
  eq(pm.getSelectedPresetName(), "野渡·NSFW", "读到 nsfw → 切到野渡·NSFW");
  const st = F("syState")();
  eq(st.mode, "nsfw", "状态 nsfw"); eq(st.base, "野渡", "记住基础预设"); eq(st.routed, "野渡·NSFW", "记住切去了哪");
  i = ai("第二楼，没写标记。");
  await fire("message_received", i);
  eq(pm.getSelectedPresetName(), "野渡·NSFW", "没标记沿用，不掉回");
  i = ai("第三楼，结束。\n<route>normal</route>");
  await fire("message_received", i);
  eq(pm.getSelectedPresetName(), "野渡", "normal → 切回野渡");
  eq(F("syState")().mode, "normal", "状态回 normal");
  eq(pm._st.history.join(">"), "野渡·NSFW>野渡", "总共只切了两次");
}

console.log("\n【4】 没有对应预设：不切、状态不动、通知一句");
{
  const { F, pm, ai, fire } = boot();
  pm.selectPreset("4");   // 酒神颂，没有 ·NSFW
  const i = ai("进入。\n<route>nsfw</route>");
  await fire("message_received", i);
  eq(pm.getSelectedPresetName(), "酒神颂", "保持酒神颂");
  eq(F("syState")().mode, "normal", "状态仍 normal");
}

console.log("\n【5】 锁定：锁 normal 不听标记；锁 nsfw 立刻切且不听 normal");
{
  const { F, pm, ai, fire, ctx } = boot();
  ctx.chatMetadata.switchyard_v1 = { mode: "normal", base: "野渡", routed: "", lock: "normal" };
  let i = ai("x\n<route>nsfw</route>"); await fire("message_received", i);
  eq(pm.getSelectedPresetName(), "野渡", "锁 normal：标记 nsfw 不切");
  ctx.chatMetadata.switchyard_v1.lock = "nsfw";
  await F("syApply")("nsfw", "手动锁定");
  eq(pm.getSelectedPresetName(), "野渡·NSFW", "锁 nsfw：切过去");
  i = ai("x\n<route>normal</route>"); await fire("message_received", i);
  eq(pm.getSelectedPresetName(), "野渡·NSFW", "锁 nsfw：标记 normal 不听");
}

console.log("\n【6】 人手动换预设：认账，新预设成为基础，模式回 normal，不会被切回去");
{
  const { F, pm, ai, fire } = boot();
  let i = ai("x\n<route>nsfw</route>"); await fire("message_received", i);
  eq(pm.getSelectedPresetName(), "野渡·NSFW", "先进 nsfw");
  pm._st.sel = 2;                                  // 人在界面上换成佩安（不经过枢轨）
  await new Promise(r => setTimeout(r, 5));
  await fire("preset_changed");
  eq(F("syState")().mode, "normal", "模式回 normal");
  eq(F("syState")().base, "佩安", "佩安成为新的基础");
  i = ai("x\n<route>nsfw</route>"); await fire("message_received", i);
  eq(pm.getSelectedPresetName(), "佩安·NSFW", "之后再进 nsfw 切的是佩安·NSFW，不是野渡的");
  i = ai("x\n<route>normal</route>"); await fire("message_received", i);
  eq(pm.getSelectedPresetName(), "佩安", "回的是佩安");
}

console.log("\n【7】 换聊天各回各的");
{
  const { F, pm, ai, fire, switchChat } = boot();
  let i = ai("x\n<route>nsfw</route>", "A"); await fire("message_received", i);
  eq(pm.getSelectedPresetName(), "野渡·NSFW", "A 在 nsfw");
  switchChat("B"); await F("syOnChatChanged")();
  eq(pm.getSelectedPresetName(), "野渡", "切到 B（normal，没记录）→ 回基础野渡");
  switchChat("A"); await F("syOnChatChanged")();
  eq(pm.getSelectedPresetName(), "野渡·NSFW", "切回 A → 恢复野渡·NSFW");
}

console.log("\n【8】 重 roll：被 roll 那楼的标记作废，按上一楼校对");
{
  const { F, pm, ai, fire } = boot();
  let i = ai("一楼进入。\n<route>nsfw</route>"); await fire("message_received", i);
  i = ai("二楼结束。\n<route>normal</route>"); await fire("message_received", i);
  eq(pm.getSelectedPresetName(), "野渡", "二楼 normal 已切回");
  await fire("generation_started", "swipe", {}, false);
  eq(pm.getSelectedPresetName(), "野渡·NSFW", "roll 二楼 → 按一楼的 nsfw 切回去再生成");
  eq(F("syState")().mode, "nsfw", "状态跟着回 nsfw");
}

console.log("\n【9】 关着什么都不做；给主 AI 的话按配置生成");
{
  const { F, pm, ai, fire, cfg } = boot();
  cfg.enabled = false;
  const i = ai("x\n<route>nsfw</route>"); await fire("message_received", i);
  eq(pm.getSelectedPresetName(), "野渡", "未启用不切");
  cfg.enabled = true;
  ok(F("sySnippet")().indexOf("<route>normal</route>") >= 0 && F("sySnippet")().indexOf("<route>nsfw</route>") >= 0, "snippet 含 normal 与已配模式");
  ok(F("sySnippet")().indexOf("预测下一轮") >= 0 && F("sySnippet")().indexOf("提前一轮") >= 0, "snippet 要求预测并提前切换");
}

console.log("\n【10】 抽屉 UI 挂上了");
{
  const { w } = boot();
  const d = w.document;
  ok(!!d.querySelector("#switchyard-drawer") && !!d.querySelector("#sy-rows .sy-row") && !!d.querySelector("#sy-lock"), "抽屉、映射行、锁定选择都在");
  ok(d.querySelector("#sy-now").textContent.indexOf("野渡") >= 0, "状态行显示当前预设");
}

console.log("\n【11】 极短路由协议由插件自动贴入，关闭插件会清空");
{
  const { F, cfg, extensionPrompts } = boot();
  F("syApplyRoutePrompt")();
  ok(Object.values(extensionPrompts).some(x => x.value.indexOf("<route>nsfw</route>") >= 0), "启用时自动贴入路由协议");
  cfg.enabled = false; F("syApplyRoutePrompt")();
  ok(Object.values(extensionPrompts).every(x => x.value === ""), "关闭时清空贴耳，不留幽灵提示词");
}

console.log("\n【12】 已有 swipe / 编辑 / 删楼后可按当前聊天重新校对");
{
  const { F, pm, ai, fire, ctx } = boot();
  let i = ai("进入。\n<route>nsfw</route>"); await fire("message_received", i);
  eq(pm.getSelectedPresetName(), "野渡·NSFW", "先进入 nsfw");
  ctx.chat.push({ is_user: true, mes: "user" }, { is_user: false, mes: "结束。\n<route>normal</route>" });
  await F("syReconcileFromChat")("测试已有 swipe");
  eq(pm.getSelectedPresetName(), "野渡", "重新校对后回 normal");
}

console.log("\n【13】 等待异步切换完成；切换失败不谎报成功、不改模式");
{
  const slow = boot({ selectDelay: 20 });
  const p = slow.F("syApply")("nsfw", "异步测试");
  eq(slow.pm.getSelectedPresetName(), "野渡", "异步完成前仍是原预设");
  const done = await p;
  eq(done.did, "switched", "等待后确认成功");
  eq(slow.pm.getSelectedPresetName(), "野渡·NSFW", "异步完成后才切换");

  const bad = boot({ selectFail: true });
  const failed = await bad.F("syApply")("nsfw", "失败测试");
  eq(failed.did, "select-failed", "失败明确返回 select-failed");
  eq(bad.pm.getSelectedPresetName(), "野渡", "失败时预设保持不动");
  eq(bad.F("syState")().mode, "normal", "失败时聊天模式不被提前污染");
}

console.log("\n【14】 新聊天尊重酒馆按角色自动选择的预设");
{
  const { F, pm, ai, fire, switchChat } = boot();
  let i = ai("x\n<route>nsfw</route>", "A"); await fire("message_received", i);
  switchChat("B");
  pm._st.sel = 2; // 模拟酒馆先按 B 的角色名自动选择了佩安
  await F("syOnChatChanged")();
  eq(pm.getSelectedPresetName(), "佩安", "不把 B 强行拉回 A 的野渡");
  eq(F("syState")().base, "佩安", "B 以佩安建立自己的基础状态");
}

console.log("\n【15】 路由标记只从显示层隐藏，聊天原文保持可回滚");
{
  const { w, F, chats } = boot();
  const text = "正文。\n<route>nsfw</route>";
  chats.A.chat.push({ is_user: false, mes: text });
  const row = w.document.createElement("div"); row.className = "mes"; row.setAttribute("mesid", "0");
  const body = w.document.createElement("div"); body.className = "mes_text"; body.textContent = text; row.appendChild(body);
  w.document.getElementById("chat").appendChild(row);
  ok(F("syHideMarkers")(0), "显示层清理执行成功");
  ok(body.textContent.indexOf("<route>") < 0 && body.textContent.indexOf("正文") >= 0, "界面隐藏标签、保留正文");
  eq(chats.A.chat[0].mes, text, "msg.mes 原文一字未改");
}

console.log("\n" + "─".repeat(46));
console.log(fail === 0 ? `全部通过 ✅  ${pass} 项` : `${pass} 通过 / ${fail} 失败 ❌`);
process.exit(fail === 0 ? 0 : 1);
})();
