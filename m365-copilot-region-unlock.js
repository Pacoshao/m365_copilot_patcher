// ==UserScript==
// @name         M365 Copilot 区域限制解除
// @namespace    https://github.com/Pacoshao/m365-copilot-region-unlock
// @version      2.0.0
// @description  解除 Microsoft 365 Copilot / Copilot 的区域限制，让 m365.cloud.microsoft 与 copilot.cloud.microsoft 的 /chat 在受限地区可用
// @author       Pacoshao
// @match        https://m365.cloud.microsoft/*
// @match        https://copilot.cloud.microsoft/*
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

(function () {
    "use strict";

    var W = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;

    /* ^^^^^^^^^^^^^^^^^^^^^^^^^^ 可调参数 ^^^^^^^^^^^^^^^^^^^^^^^^^^ */
    var OPTIONS = {
        // 仅在检测到「区域受限」时才动手（正常可用的账号不会被干扰）
        engageOnlyWhenRegionBlocked: true,

        // 需要一并点亮的应用开关（站点把它们和区域资格绑在一起）
        unlockApps: [
            "isChatEligible",
            "isLibraryEligible",
            "isProjectsEligible",
            "isConversationsEnabled",
            "isAgentsEnabled"
        ],

        // 启动阶段高频轮询，覆盖 SSR 水合 / 首屏路由判定
        fastPollMs: 16,
        fastPollDurationMs: 30000,

        // 之后低频兜底，防止站点回源刷新资格数据后又被锁
        slowPollMs: 250,

        // 控制台输出
        debug: false
    };
    /* vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv */

    var TAG = "[M365区域解锁]";
    var state = {
        engaged: false,     // 是否已经判定为「受限」，判过一次就一直维持
        patched: 0,         // 累计修补次数
        lastHook: null
    };

    function log() {
        if (!OPTIONS.debug) { return; }
        try {
            var args = Array.prototype.slice.call(arguments);
            args.unshift(TAG);
            console.log.apply(console, args);
        } catch (e) { /* ignore */ }
    }

    function assign(target) {
        for (var i = 1; i < arguments.length; i++) {
            var src = arguments[i];
            if (!src) { continue; }
            for (var k in src) {
                if (Object.prototype.hasOwnProperty.call(src, k)) { target[k] = src[k]; }
            }
        }
        return target;
    }

    /* ---------------------- 判定与修补 ---------------------- */

    function readState(store) {
        if (!store) { return null; }
        try {
            if (typeof store.getState === "function") { return store.getState(); }
        } catch (e) { /* ignore */ }
        return store;
    }

    // 已经处于完全可用状态？
    function isUnlocked(s) {
        var e = s.eligibility;
        if (!e || e.isCopilotEnabledRegion !== true || e.isCopilotEligible !== true) { return false; }
        var a = s.appsConfig;
        if (a) {
            for (var i = 0; i < OPTIONS.unlockApps.length; i++) {
                var k = OPTIONS.unlockApps[i];
                if (k in a && a[k] !== true) { return false; }
            }
        }
        return true;
    }

    // 是否需要介入
    function shouldEngage(s) {
        if (state.engaged) { return true; }
        if (!OPTIONS.engageOnlyWhenRegionBlocked) { return true; }
        try {
            if (location.pathname.indexOf("/chat/blocked") !== -1) { return true; }
        } catch (e) { /* ignore */ }
        var e = s.eligibility;
        return !!e && e.isCopilotEnabledRegion === false;
    }

    function buildPatch() {
        var elig = {
            isCopilotEnabledRegion: true,
            isCopilotEligible: true,
            isOptedOutByAdmin: false,
            isError: false
        };
        var apps = {};
        return { elig: elig, apps: apps };
    }

    function applyTo(store) {
        var s = readState(store);
        if (!s || !s.eligibility) { return; }
        if (!shouldEngage(s)) { return; }
        state.engaged = true;
        if (isUnlocked(s)) { return; }

        var patch = buildPatch();
        var a = s.appsConfig;
        if (a) {
            for (var i = 0; i < OPTIONS.unlockApps.length; i++) {
                var k = OPTIONS.unlockApps[i];
                if (k in a) { patch.apps[k] = true; }
            }
        }

        // 首选：走 zustand 的 setState（浅合并），不会打乱 React 的订阅
        var ok = false;
        if (typeof store.setState === "function") {
            try {
                store.setState(function (prev) {
                    var next = { eligibility: assign({}, prev.eligibility, patch.elig) };
                    if (prev.appsConfig) {
                        next.appsConfig = assign({}, prev.appsConfig, patch.apps);
                    }
                    return next;
                });
                ok = true;
            } catch (e) {
                ok = false;
            }
        }

        // 兜底：直接就地改字段（站点若换掉 store 实现仍然有效）
        if (!ok || !isUnlocked(readState(store) || s)) {
            try {
                var cur = readState(store) || s;
                if (cur.eligibility) { assign(cur.eligibility, patch.elig); }
                if (cur.appsConfig) { assign(cur.appsConfig, patch.apps); }
            } catch (e) { /* ignore */ }
        }

        state.patched++;
        if (state.patched === 1) {
            try { console.info(TAG, "已解除 Copilot 区域限制，正在进入聊天主页"); } catch (e) { /* ignore */ }
        } else {
            log("再次修正资格状态，第 " + state.patched + " 次");
        }
    }

    // 处理 SSR 直接下发的纯对象（没有 setState 的场景）
    function applyToPlain(plainStore) {
        if (!plainStore || !plainStore.eligibility) { return; }
        if (!shouldEngage(plainStore)) { return; }
        state.engaged = true;
        if (isUnlocked(plainStore)) { return; }
        var patch = buildPatch();
        if (plainStore.appsConfig) {
            var a = plainStore.appsConfig;
            for (var i = 0; i < OPTIONS.unlockApps.length; i++) {
                var k = OPTIONS.unlockApps[i];
                if (k in a) { patch.apps[k] = true; }
            }
            assign(a, patch.apps);
        }
        assign(plainStore.eligibility, patch.elig);
        log("已修补 SSR 下发数据");
    }

    /* ---------------------- 定位 store ---------------------- */

    function scanRouter() {
        var router = W.__TSR_ROUTER__;
        if (!router || !router.state) { return false; }
        var matches = router.state.matches || [];
        var hit = false;
        for (var i = 0; i < matches.length; i++) {
            var ctx = matches[i] && matches[i].context;
            if (ctx && ctx.store) {
                applyTo(ctx.store);
                hit = true;
            }
        }
        return hit;
    }

    /* ---------------------- SSR 水合兜底 ---------------------- */

    // 站点当前版本基本不再读它，但保留一层防御：
    // 老版本 / 其他构建若仍然通过 window.__staticRouterHydrationData 下发，
    // 这里会在赋值瞬间把 eligibility 修好。
    try {
        var current = W.__staticRouterHydrationData;
        if (current) { applyToPlain(current.loaderData && current.loaderData.root && current.loaderData.root.store); }
        Object.defineProperty(W, "__staticRouterHydrationData", {
            configurable: true,
            enumerable: true,
            get: function () { return current; },
            set: function (value) {
                current = value;
                try {
                    var st = value && value.loaderData && value.loaderData.root && value.loaderData.root.store;
                    if (st) { applyToPlain(st); }
                } catch (e) { /* ignore */ }
            }
        });
        state.lastHook = "defineProperty";
    } catch (e) {
        state.lastHook = "unavailable";
    }

    /* ---------------------- 轮询循环 ---------------------- */

    var startedAt = Date.now();
    var timer = null;

    function tick() {
        var hit = false;
        try { hit = scanRouter(); } catch (e) { /* ignore */ }

        var elapsed = Date.now() - startedAt;
        var fast = elapsed < OPTIONS.fastPollDurationMs;
        var delay = fast ? OPTIONS.fastPollMs : OPTIONS.slowPollMs;

        // 首屏还没挂上 router 时加速探测
        if (!hit && !fast) { delay = 100; }

        timer = setTimeout(tick, delay);
    }

    tick();

    // 单页应用切回标签页 / 前进后退时补一次
    try {
        document.addEventListener("visibilitychange", function () {
            if (!document.hidden) { try { scanRouter(); } catch (e) { /* ignore */ } }
        });
        W.addEventListener("pageshow", function () {
            try { scanRouter(); } catch (e) { /* ignore */ }
        });
    } catch (e) { /* ignore */ }

    /* ---------------------- 对外调试接口 ---------------------- */

    try {
        W.__M365RegionUnlock = {
            version: "2.0.0",
            options: OPTIONS,
            status: state,
            run: function () { return scanRouter(); }
        };
    } catch (e) { /* ignore */ }
})();
