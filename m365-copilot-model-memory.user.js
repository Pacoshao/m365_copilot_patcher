// ==UserScript==
// @name         M365 Copilot 记住模型选择
// @namespace    https://github.com/Pacoshao/m365-copilot-region-unlock
// @version      1.0.0
// @description  让 Microsoft 365 Copilot 记住你上次选的模型，而不是每次刷新都回到「自动」
// @author       Pacoshao
// @match        https://m365.cloud.microsoft/*
// @match        https://copilot.cloud.microsoft/*
// @run-at       document-end
// @grant        none
// @license      MIT
// ==/UserScript==

/*
 * 背景
 * ------------------------------------------------------------------
 * 站点（2026-11 版）**不会记住**模型选择：每次刷新 / 新开会话都回到「自动」。
 * 实测确认，选择状态既没有写进 localStorage / sessionStorage / cookie，
 * 也不在 zustand store（gptMode 恒为 "auto"），而是只存在于模型选择器组件内部，
 * 随每次加载重置。所以只能由脚本自己记、自己恢复。
 *
 * 做法
 * ------------------------------------------------------------------
 * 1. 监听输入框上方模型选择器按钮的 aria-label，用户一换模型就把它记进
 *    localStorage（记下显示名、菜单项名和选项 id）。
 * 2. 每次页面加载后，如果当前不是上次选的那个，就程序化地把菜单点开、
 *    必要时展开 GPT 子菜单、选中对应项，恢复到上次的选择。
 *
 * 为什么要用 React 的 onClick 而不是 el.click()
 * ------------------------------------------------------------------
 * Fluent UI 的菜单按钮不响应合成的 click 事件（实测 dispatchEvent 点不开），
 * 但它的 React props 上挂着真实的 onClick，直接调用即可打开菜单。
 * 菜单项同理。
 * ------------------------------------------------------------------
 */

(function () {
    "use strict";

    var W = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;

    /* ^^^^^^^^^^^^^^^^^^^^^^^^^^ 可调参数 ^^^^^^^^^^^^^^^^^^^^^^^^^^ */
    var OPTIONS = {
        // localStorage 键名
        storageKey: "m365CopilotModelMemory:v1",

        // 模型选择器按钮的 aria-label 特征（中英文都覆盖）
        selectorRe: /模型选择器|model selector/i,

        // 从 aria-label 里剥掉的后缀
        suffixRe: /[\u3001,\uFF0C]?\s*(模型选择器|model selector)\s*$/i,

        // 监听选择变化的轮询间隔
        watchMs: 400,

        // 打开菜单 / 选中后的等待上限
        menuTimeoutMs: 4000,

        // 调试输出
        debug: false
    };
    /* vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv */

    var TAG = "[Copilot记住模型]";
    var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

    var runtime = {
        applying: false,     // 正在程序化恢复，期间不要记录为用户操作
        restored: false,     // 本次页面已尝试过恢复
        lastSeen: null,      // 上一次观察到的按钮显示名
        clicks: 0
    };

    function log() {
        if (!OPTIONS.debug) { return; }
        try {
            var a = Array.prototype.slice.call(arguments);
            a.unshift(TAG);
            console.log.apply(console, a);
        } catch (e) { /* ignore */ }
    }

    function norm(s) {
        return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    }

    /* ---------------------- 偏好存取 ---------------------- */

    function loadPref() {
        try {
            var raw = W.localStorage.getItem(OPTIONS.storageKey);
            if (!raw) { return null; }
            var p = JSON.parse(raw);
            if (p && typeof p.label === "string" && p.label) { return p; }
        } catch (e) { /* ignore */ }
        return null;
    }

    function savePref(pref) {
        try { W.localStorage.setItem(OPTIONS.storageKey, JSON.stringify(pref)); } catch (e) { /* ignore */ }
    }

    /* ---------------------- DOM 交互 ---------------------- */

    // 直接调用 React 的 onClick —— 合成事件点不开 Fluent 菜单
    function reactClick(el) {
        if (!el) { return false; }
        var key = null;
        var keys = Object.keys(el);
        for (var i = 0; i < keys.length; i++) {
            if (keys[i].indexOf("__reactProps") === 0) { key = keys[i]; break; }
        }
        if (key) {
            var props = el[key];
            if (props && typeof props.onClick === "function") {
                try {
                    props.onClick({
                        preventDefault: function () { },
                        stopPropagation: function () { },
                        nativeEvent: {},
                        currentTarget: el,
                        target: el,
                        button: 0,
                        type: "click",
                        persist: function () { },
                        defaultPrevented: false
                    });
                    runtime.clicks++;
                    return true;
                } catch (e) { /* fallthrough */ }
            }
        }
        // 兜底：完整指针序列
        try {
            var r = el.getBoundingClientRect();
            var opts = {
                clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
                bubbles: true, cancelable: true, view: W,
                button: 0, buttons: 1, pointerId: 1, isPrimary: true, pointerType: "mouse"
            };
            var seq = [
                ["pointerover", true], ["pointerenter", true], ["pointerdown", true],
                ["mousedown", false], ["pointerup", true], ["mouseup", false], ["click", false]
            ];
            for (var j = 0; j < seq.length; j++) {
                var name = seq[j][0];
                var Ctor = seq[j][1] ? W.PointerEvent : W.MouseEvent;
                el.dispatchEvent(new Ctor(name, opts));
            }
            return true;
        } catch (e) {
            return false;
        }
    }

    function findTrigger() {
        var btns = document.querySelectorAll("button[aria-label]");
        for (var i = 0; i < btns.length; i++) {
            var al = btns[i].getAttribute("aria-label") || "";
            if (OPTIONS.selectorRe.test(al)) { return btns[i]; }
        }
        return null;
    }

    function currentLabel() {
        var b = findTrigger();
        if (!b) { return null; }
        var al = b.getAttribute("aria-label") || "";
        return norm(al.replace(OPTIONS.suffixRe, ""));
    }

    function radios() {
        return Array.prototype.slice.call(document.querySelectorAll('[role="menuitemradio"]'));
    }

    function menus() {
        return Array.prototype.slice.call(document.querySelectorAll('[role="menu"]'));
    }

    function menuOpen() {
        return radios().length > 0;
    }

    async function waitFor(fn, timeout) {
        var end = Date.now() + (timeout || OPTIONS.menuTimeoutMs);
        while (Date.now() < end) {
            var v = fn();
            if (v) { return v; }
            await sleep(80);
        }
        return null;
    }

    async function openMenu() {
        if (menuOpen()) { return true; }
        var trig = findTrigger();
        if (!trig) { return false; }
        reactClick(trig);
        return !!(await waitFor(function () { return menuOpen(); }, OPTIONS.menuTimeoutMs));
    }

    async function closeMenu() {
        if (!menuOpen()) { return; }
        var trig = findTrigger();
        if (trig) { reactClick(trig); }
        await waitFor(function () { return !menuOpen(); }, 1500);
    }

    // 在菜单里找到文本以 title 开头的那一项
    function findRadio(title) {
        var target = norm(title);
        var list = radios();
        for (var i = 0; i < list.length; i++) {
            if (norm(list[i].innerText).indexOf(target) === 0) { return list[i]; }
        }
        return null;
    }

    // 展开所有折叠的子菜单（GPT 分组之类），直到出现目标项或已无可展开项
    async function expandUntilFound(title) {
        var hit = findRadio(title);
        if (hit) { return hit; }
        var tried = [];
        for (var round = 0; round < 5; round++) {
            var groups = Array.prototype.slice.call(document.querySelectorAll('[role="menuitem"]'));
            var next = null;
            for (var i = 0; i < groups.length; i++) {
                if (tried.indexOf(groups[i]) === -1) { next = groups[i]; break; }
            }
            if (!next) { break; }
            tried.push(next);
            reactClick(next);
            await sleep(500);
            hit = findRadio(title);
            if (hit) { return hit; }
        }
        return findRadio(title);
    }

    /* ---------------------- 从 store 里取选项元数据 ---------------------- */

    // 选择器按钮显示的是 shortTitle（例如「GPT-5.6 Sol 思考」），
    // 而菜单项文本是 menuItemTitle（「GPT-5.6 Sol 深度思考」），
    // 两边对不上，所以优先从 store 元数据里做一次映射。
    function readOptionMeta() {
        try {
            var router = W.__TSR_ROUTER__;
            if (!router || !router.state) { return null; }
            var matches = router.state.matches || [];
            var store = null;
            for (var i = 0; i < matches.length; i++) {
                var ctx = matches[i] && matches[i].context;
                if (ctx && ctx.store && typeof ctx.store.getState === "function") { store = ctx.store; break; }
            }
            if (!store) { return null; }
            var s = store.getState();
            var owners = ["bizchatAsAgentGpt", "bizchatAsAgentGptWebTab"];
            for (var j = 0; j < owners.length; j++) {
                var holder = s[owners[j]];
                var md = holder && holder.clientPreferences && holder.clientPreferences.modelSelectorMetadata;
                if (!md) { continue; }
                var raw = md.availableModelSelectionOptions;
                if (typeof raw === "string") { raw = JSON.parse(raw); }
                if (!Array.isArray(raw)) { continue; }
                var flat = [];
                (function walk(arr) {
                    for (var k = 0; k < arr.length; k++) {
                        var item = arr[k];
                        if (!item) { continue; }
                        if (Array.isArray(item.itemGroup)) { walk(item.itemGroup); continue; }
                        if (item.id) {
                            flat.push({
                                id: item.id,
                                title: item.menuItemTitle || item.id,
                                short: item.shortTitle || item.menuItemTitle || item.id
                            });
                        }
                    }
                })(raw);
                if (flat.length) { return flat; }
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    // 显示名 -> 菜单项名
    function resolveTitle(label, meta) {
        var target = norm(label);
        if (meta) {
            var byShort = null, byTitle = null;
            for (var i = 0; i < meta.length; i++) {
                if (norm(meta[i].short) === target) { byShort = meta[i]; break; }
                if (norm(meta[i].title) === target) { byTitle = meta[i]; }
            }
            var opt = byShort || byTitle;
            if (opt) { return { title: opt.title, id: opt.id }; }

            // 官方改名（例如标题后缀变化）时，退一步做包含匹配，
            // 仍然以官方当前提供的列表为准，不引入任何本地常量。
            for (var j = 0; j < meta.length; j++) {
                var cand = norm(meta[j].title);
                var candShort = norm(meta[j].short);
                if (!cand && !candShort) { continue; }
                if ((target && cand && (cand.indexOf(target) === 0 || target.indexOf(cand) === 0)) ||
                    (target && candShort && (candShort.indexOf(target) === 0 || target.indexOf(candShort) === 0))) {
                    return { title: meta[j].title, id: meta[j].id };
                }
            }
        }
        return { title: target, id: null };
    }

    /* ---------------------- 恢复 / 记录 ---------------------- */

    async function applyPref(pref, label) {
        var meta = readOptionMeta();
        var resolved = resolveTitle(label, meta);

        runtime.applying = true;
        try {
            if (!(await openMenu())) {
                log("打不开模型菜单，放弃恢复");
                return false;
            }
            var radio = await expandUntilFound(resolved.title);
            if (!radio) {
                log("菜单里找不到 " + resolved.title + "，放弃恢复");
                await closeMenu();
                return false;
            }
            reactClick(radio);
            var changed = await waitFor(function () {
                return currentLabel() === norm(label);
            }, 3000);
            if (changed) {
                log("已恢复模型：" + label);
                return true;
            }
            log("已点击 " + resolved.title + "，但按钮未更新");
            return false;
        } finally {
            await sleep(200);
            runtime.applying = false;
            runtime.lastSeen = currentLabel();
        }
    }

    function recordIfChanged() {
        // 首次恢复还没跑完时不要记录：那一瞬间按钮显示的是默认的「自动」，
        // 记下去会覆盖掉用户真正的偏好，导致下次永远恢复不了。
        if (!runtime.restored || runtime.applying) { return; }
        var label = currentLabel();
        if (!label || label === runtime.lastSeen) { return; }
        runtime.lastSeen = label;

        var meta = readOptionMeta();
        var resolved = resolveTitle(label, meta);
        savePref({
            label: label,
            title: resolved.title,
            id: resolved.id,
            savedAt: Date.now()
        });
        log("已记住模型：" + label);
    }

    async function restoreOnce() {
        if (runtime.restored) { return; }
        var pref = loadPref();
        if (!pref) { return; }
        var label = await waitFor(function () { return currentLabel(); }, 20000);
        if (!label) { return; }
        runtime.restored = true;
        runtime.lastSeen = label;
        if (label === norm(pref.label)) {
            log("当前已是上次选择的模型：" + label);
            return;
        }
        // 等输入框那一轮回合结束再动手，避免菜单被重渲染打断
        await sleep(400);
        await applyPref(pref, pref.label);
    }

    /* ---------------------- 启动 ---------------------- */

    function boot() {
        restoreOnce();
        setInterval(recordIfChanged, OPTIONS.watchMs);
        setInterval(function () { restoreOnce(); }, 2000);

        try {
            W.__CopilotModelMemory = {
                version: "1.0.0",
                options: OPTIONS,
                runtime: runtime,
                read: loadPref,
                clear: function () { try { W.localStorage.removeItem(OPTIONS.storageKey); } catch (e) { } },
                apply: function (label) { return applyPref(loadPref(), label || (loadPref() || {}).label); }
            };
        } catch (e) { /* ignore */ }

        log("已启动");
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot);
    } else {
        boot();
    }
})();
