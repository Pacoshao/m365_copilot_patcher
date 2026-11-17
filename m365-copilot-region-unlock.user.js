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

/*
 * 原理（2026-11 版站点）
 * ------------------------------------------------------------------
 * 当前站点已从 React Router 的 window.__staticRouterHydrationData 迁移到
 * TanStack Router：真正的应用状态挂在 window.__TSR_ROUTER__ 的路由 context 里，
 * 是一个 zustand store：
 *
 *   __TSR_ROUTER__.state.matches[i].context.store.getState()
 *
 * 其中决定「区域限制」的字段只有两个：
 *   store.getState().eligibility.isCopilotEnabledRegion   // 账号所在区域是否开放
 *   store.getState().eligibility.isCopilotEligible        // 当前账号是否具备 Copilot 资格
 *
 * 命中时站点会 SPA 跳到 /chat/blocked，并渲染「Copilot Chat 在你所在的区域不可用」。
 *
 * 实测结论（已在真实受限账号上验证）：
 *   只把 isCopilotEnabledRegion 改成 true —— 仍然停在 /chat/blocked，聊天不可用；
 *   同时把 isCopilotEligible 改成 true   —— 直接进入 /home，输入框可用，
 *                                          能正常收发消息（服务端不做区域拦截）。
 *
 * 所以本脚本在 document-start 阶段就开始轮询路由器 store，一旦发现处于受限状态，
 * 就通过 store.setState() 把这两个字段（以及被一并联锁关闭的 appsConfig 开关）
 * 改写为可用值。之后若站点重新拉取资格数据把值刷回去，会在下一轮轮询里再次修正。
 * ------------------------------------------------------------------
 */

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

        // 解锁后补全左侧导航里缺失的入口。
        // 区域受限的账号，服务端下发的 coreAppsContent 只有 Search / Plugins，
        // 连「新建聊天」都没有；这里的条目会被合并进 store，站点随即渲染出来。
        completeNav: true,

        // 需要补全的导航项。id 取自站点自己的导航枚举，
        // 图标地址全部为线上实际存在的官方资源（逐个探测过）。
        // 站点的导航渲染规则（实测）：label 长度 <= 1 时，它认为这是个 key，
        // 会拿 id 去查自己的本地化文案；label 更长时则原样显示 label。
        //
        // 所以这里分两类：
        //   lookup=true  → label 只给一个占位字符，交给站点按 id 查官方文案
        //                  （Projects 会显示成「工作区」、Library 显示成「库」）
        //   lookup=false → 用完整 label 直接显示（chat 没有官方文案，必须自己给）
        navItems: [
            // chat 不能沿用官方那个 id：站点会认出它并套用自己的文案，
            // 而该文案在中文界面下会被渲染成单个「新」字。
            // 换一个普通 id + 显式 label，就能正常显示「新建聊天」。
            { key: "chat", id: "M365CopilotNewChat", lookup: false,
              label: "New chat", labelZh: "新建聊天", path: "/chat",
              icon: "bebop-chats.svg", iconFilled: "bebop-chats-filled.svg" },
            { key: "library", id: "Library", lookup: true, label: "L", labelZh: "L", path: "/library",
              icon: "library.svg", iconFilled: "bebop-library-filled.svg" },
            { key: "projects", id: "Projects", lookup: true, label: "P", labelZh: "P", path: "/projects",
              icon: "bebop-projects.svg", iconFilled: "bebop-projects-filled.svg" },
            { key: "agents", id: "Agents", lookup: false,
              label: "Agents", labelZh: "智能体", path: "/agents",
              icon: "bebop-tasks.svg", iconFilled: "bebop-agents-filled.svg" }
        ],

        // 官方图标根地址
        iconBase: "https://res.public.onecdn.static.microsoft/midgard/versionless/m365copilotresources/apps/",

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

        // 先校验导航：解锁之后这个函数会被上面的 isUnlocked 提前 return 掉，
        // 所以补全不能再依赖它——每次轮询都跑一遍，缺了就补。
        try { completeNav(store); } catch (e) { /* ignore */ }

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

    /* ---------------------- 补全左侧导航 ---------------------- */

    // 区域受限账号拿到的 coreAppsContent 只有 Search / Plugins，
    // 「新建聊天」、库、项目、智能体等入口都不会下发。
    // 这里按站点自己的数据结构把缺的项补上，站点随即渲染出来。
    var navDone = false;

    function completeNav(store) {
        // 每次轮询都校验一遍：站点重新拉取数据、或路由切换重建了
        // coreAppsContent 时，缺的项会被自动补回。
        // 已经存在时 added 为空，不会触发多余的 setState。
        if (!OPTIONS.completeNav) { return; }
        var s = readState(store);
        if (!s || !Array.isArray(s.coreAppsContent)) { return; }
        if (!isUnlocked(s)) { return; }

        var have = {};
        for (var i = 0; i < s.coreAppsContent.length; i++) {
            var it = s.coreAppsContent[i];
            if (it && it.id) { have[it.id] = true; }
        }

        var zh = /^zh/i.test(String(s.locale || ""));
        var added = [];
        for (var j = 0; j < OPTIONS.navItems.length; j++) {
            var def = OPTIONS.navItems[j];
            if (have[def.id]) { continue; }
            added.push({
                id: def.id,
                // label 只有 1 个字符时站点会改用自己的本地化文案，详见 OPTIONS.navItems 注释
                label: (zh && def.labelZh) ? def.labelZh : def.label,
                path: def.path,
                iconSrc: OPTIONS.iconBase + def.icon,
                selectedIconSrc: OPTIONS.iconBase + def.iconFilled,
                coloredSelectedIcon: false
            });
        }
        if (!added.length) { navDone = true; return; }

        if (typeof store.setState === "function") {
            store.setState(function (prev) {
                return { coreAppsContent: added.concat(prev.coreAppsContent || []) };
            });
        } else if (Array.isArray(s.coreAppsContent)) {
            s.coreAppsContent = added.concat(s.coreAppsContent);
        }
        navDone = true;
        log("已补全导航入口：" + added.map(function (a) { return a.label; }).join("、"));
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
