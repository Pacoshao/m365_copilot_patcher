// ==UserScript==
// @name         M365 Copilot 区域限制解除
// @namespace    https://github.com/Pacoshao/m365_copilot_patcher
// @version      3.0.0
// @description  解除 Microsoft 365 Copilot 的区域限制，让 m365.cloud.microsoft 与 copilot.cloud.microsoft 的聊天界面在受限地区可用
// @author       Pacoshao
// @match        https://m365.cloud.microsoft/*
// @match        https://copilot.cloud.microsoft/*
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

/*
 * 原理（2026-11-18 版站点）
 * ==================================================================
 * 区域受限时，站点不再停在「Copilot Chat 不可用」页，而是直接整页跳转
 * 到搜索页 /search。跳转来自 TanStack 路由守卫：它在 hydration 阶段发现
 * 账号不合格，就抛一个 307 重定向出去。
 *
 * 关键点：决定资格的并不是下面这两处，改了也没用——
 *   - zustand store（__TSR_ROUTER__ 里的 store）：出现得太晚，守卫早跑完了
 *   - window.__staticRouterHydrationData：实测改了照样被踢走
 *
 * 真正被守卫读取的，是 SSR 直接内联下发的那段 streamed 路由载荷：
 *
 *   <script>self.$_TSR={...}</script>
 *   <script>$_TSR.router=($R=>($R[0]={manifest:...,matches:...,dehydratedData:...}))(...)</script>
 *
 * 所以本脚本的核心是在 document-start 阶段把 window.$_TSR 改成访问器，
 * 等站点给它赋 router 的那一刻，直接深挖整棵载荷对象，把
 * eligibility / appsConfig 里和区域相关的开关就地改成可用值。
 * 这样守卫拿到的就已经是放行后的数据，根本不会跳转。
 *
 * 载荷里实际存在的字段（实测）：
 *   x.eligibility.isCopilotEnabledRegion   // 区域是否开放
 *   x.eligibility.isCopilotEligible        // 账号是否具备资格
 *   x.appsConfig.isChatEligible            // 聊天入口开关
 * ==================================================================
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

        // 载荷深挖的最大深度
        graphMaxDepth: 8,

        // 启动阶段高频轮询，覆盖水合 / 首屏路由判定
        fastPollMs: 16,
        fastPollDurationMs: 30000,

        // 之后低频兜底，防止站点回源刷新资格数据后又被锁
        slowPollMs: 250,

        // 解锁后补全左侧导航里缺失的入口。
        // 区域受限的账号，服务端下发的 coreAppsContent 只有 Search / Plugins，
        // 连「新建聊天」都没有；这里的条目会被合并进 store，站点随即渲染出来。
        completeNav: true,

        // 需要补全的导航项。
        // 站点的渲染规则（实测）：label 只有 1 个字符时，它把这当作 key，
        // 会拿 id 去查自己的本地化文案；label 更长时则原样显示。
        navItems: [
            // chat 不能沿用官方那个 id：站点会认出它并套用自己的文案，
            // 而该文案在中文界面下会被截成单个「新」字。
            { key: "chat", id: "M365CopilotNewChat", label: "New chat", labelZh: "新建聊天",
              path: "/chat", icon: "bebop-chats.svg", iconFilled: "bebop-chats-filled.svg" },
            { key: "library", id: "Library", label: "L", labelZh: "L",
              path: "/library", icon: "library.svg", iconFilled: "bebop-library-filled.svg" },
            { key: "projects", id: "Projects", label: "P", labelZh: "P",
              path: "/projects", icon: "bebop-projects.svg", iconFilled: "bebop-projects-filled.svg" },
            { key: "agents", id: "Agents", label: "Agents", labelZh: "智能体",
              path: "/agents", icon: "bebop-tasks.svg", iconFilled: "bebop-agents-filled.svg" }
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
        patched: 0,         // store 级修补次数
        navPatched: 0,      // 导航补全次数
        payloadHits: 0,     // 载荷深挖命中的 eligibility 数
        payloadPatched: 0,  // 载荷实际修改次数
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

    /* ---------------------- 字段修补 ---------------------- */

    var ELIG_PATCH = {
        isCopilotEnabledRegion: true,
        isCopilotEligible: true,
        isOptedOutByAdmin: false,
        isError: false
    };

    function buildAppsPatch(current) {
        var out = {};
        if (!current) { return out; }
        for (var i = 0; i < OPTIONS.unlockApps.length; i++) {
            var k = OPTIONS.unlockApps[i];
            if (k in current) { out[k] = true; }
        }
        return out;
    }

    // 是不是一个「受限」的 eligibility 对象
    function looksBlocked(e) {
        return !!e && (e.isCopilotEnabledRegion === false || e.isCopilotEligible === false);
    }

    function applyToEligibility(e) {
        if (!e || typeof e !== "object") { return false; }
        if (e.isCopilotEnabledRegion === true && e.isCopilotEligible === true) { return false; }
        var keys = Object.keys(ELIG_PATCH);
        for (var i = 0; i < keys.length; i++) {
            if (e[keys[i]] !== ELIG_PATCH[keys[i]]) { e[keys[i]] = ELIG_PATCH[keys[i]]; }
        }
        return true;
    }

    function applyToAppsConfig(a) {
        if (!a || typeof a !== "object") { return false; }
        var patch = buildAppsPatch(a);
        var changed = false;
        for (var k in patch) {
            if (Object.prototype.hasOwnProperty.call(patch, k) && a[k] !== true) { a[k] = true; changed = true; }
        }
        return changed;
    }

    /* ---------------------- 载荷深挖 ---------------------- */

    // 就地遍历整棵 SSR 载荷，命中 eligibility / appsConfig 就修
    function patchGraph(root) {
        if (!root || typeof root !== "object") { return 0; }
        var seen = new WeakSet();
        var changed = 0;

        function walk(o, depth) {
            if (!o || typeof o !== "object" || depth > OPTIONS.graphMaxDepth || seen.has(o)) { return; }
            seen.add(o);

            try {
                var e = o.eligibility;
                if (e && typeof e === "object") {
                    state.payloadHits++;
                    if (looksBlocked(e)) { state.engaged = true; }
                    if (state.engaged && applyToEligibility(e)) {
                        changed++;
                        state.payloadPatched++;
                    }
                }
                var a = o.appsConfig;
                if (a && typeof a === "object" && state.engaged) {
                    if (applyToAppsConfig(a)) { changed++; }
                }
            } catch (err) { /* ignore */ }

            var keys;
            try { keys = Object.keys(o); } catch (err) { return; }
            for (var i = 0; i < keys.length; i++) {
                var v;
                try { v = o[keys[i]]; } catch (err) { continue; }
                if (v && typeof v === "object") { walk(v, depth + 1); }
            }
        }

        walk(root, 0);
        return changed;
    }

    /* ---------------------- 主钩子：$_TSR streamed 载荷 ---------------------- */

    // 站点给 window.$_TSR 赋值时包一层 Proxy，
    // 等它紧接着执行 $_TSR.router = (...) 时立即修补载荷。
    function installTsrHook() {
        try {
            if (Object.prototype.hasOwnProperty.call(W, "$_TSR")) {
                // 已经被站点先赋值了（正常不会发生，document-start 应该更早）
                try { patchGraph(W.$_TSR); } catch (e) { /* ignore */ }
                state.lastHook = "tsr-existing";
                return;
            }
            var real;
            Object.defineProperty(W, "$_TSR", {
                configurable: true,
                enumerable: true,
                get: function () { return real; },
                set: function (v) {
                    try {
                        real = new Proxy(v, {
                            set: function (target, key, value) {
                                if (key === "router") {
                                    try {
                                        var n = patchGraph(value);
                                        if (n) {
                                            console.info(TAG, "已在路由载荷里解除区域限制（修补 " + n + " 处）");
                                        }
                                    } catch (e) { /* ignore */ }
                                }
                                target[key] = value;
                                return true;
                            }
                        });
                    } catch (e) {
                        real = v;
                    }
                }
            });
            state.lastHook = "tsr";
        } catch (e) {
            state.lastHook = "tsr-failed";
        }
    }

    /* ---------------------- 兜底钩子：老的 React Router 水合数据 ---------------------- */

    function installHydrationHook() {
        try {
            var current = W.__staticRouterHydrationData;
            if (current) { patchGraph(current); }
            Object.defineProperty(W, "__staticRouterHydrationData", {
                configurable: true,
                enumerable: true,
                get: function () { return current; },
                set: function (value) {
                    current = value;
                    try { patchGraph(value); } catch (e) { /* ignore */ }
                }
            });
            if (!state.lastHook) { state.lastHook = "hydration"; }
        } catch (e) {
            if (!state.lastHook) { state.lastHook = "hydration-failed"; }
        }
    }

    /* ---------------------- store 级修补（导航补全也在这里） ---------------------- */

    function readState(store) {
        if (!store) { return null; }
        try {
            if (typeof store.getState === "function") { return store.getState(); }
        } catch (e) { /* ignore */ }
        return store;
    }

    function isUnlockedState(s) {
        if (!s || !s.eligibility) { return false; }
        if (looksBlocked(s.eligibility)) { return false; }
        var a = s.appsConfig;
        if (a) {
            for (var i = 0; i < OPTIONS.unlockApps.length; i++) {
                var k = OPTIONS.unlockApps[i];
                if (k in a && a[k] !== true) { return false; }
            }
        }
        return true;
    }

    function shouldEngageState(s) {
        if (state.engaged) { return true; }
        if (!OPTIONS.engageOnlyWhenRegionBlocked) { return true; }
        try {
            if (location.pathname.indexOf("/chat/blocked") !== -1) { return true; }
        } catch (e) { /* ignore */ }
        return looksBlocked(s.eligibility);
    }

    // 补全左侧导航
    function completeNav(store, s) {
        if (!OPTIONS.completeNav) { return; }
        if (!Array.isArray(s.coreAppsContent)) { return; }

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
                label: (zh && def.labelZh) ? def.labelZh : def.label,
                path: def.path,
                iconSrc: OPTIONS.iconBase + def.icon,
                selectedIconSrc: OPTIONS.iconBase + def.iconFilled,
                coloredSelectedIcon: false
            });
        }
        if (!added.length) { return; }

        if (typeof store.setState === "function") {
            store.setState(function (prev) {
                return { coreAppsContent: added.concat(prev.coreAppsContent || []) };
            });
        } else {
            s.coreAppsContent = added.concat(s.coreAppsContent);
        }
        state.navPatched++;
        log("已补全导航入口：" + added.map(function (x) { return x.label; }).join("、"));
    }

    function applyToStore(store) {
        var s = readState(store);
        if (!s || !s.eligibility) { return; }
        if (!shouldEngageState(s)) { return; }
        state.engaged = true;

        // 先校验导航：资格修好之后下面的逻辑会提前返回，补充不能依赖它
        try { completeNav(store, s); } catch (e) { /* ignore */ }

        if (isUnlockedState(s)) { return; }

        var elig = assign({}, s.eligibility, ELIG_PATCH);
        var apps = s.appsConfig ? assign({}, s.appsConfig, buildAppsPatch(s.appsConfig)) : null;

        var ok = false;
        if (typeof store.setState === "function") {
            try {
                store.setState(function (prev) {
                    var next = { eligibility: assign({}, prev.eligibility, ELIG_PATCH) };
                    if (prev.appsConfig) { next.appsConfig = assign({}, prev.appsConfig, buildAppsPatch(prev.appsConfig)); }
                    return next;
                });
                ok = true;
            } catch (e) { ok = false; }
        }
        if (!ok) {
            try {
                assign(s.eligibility, ELIG_PATCH);
                if (s.appsConfig) { assign(s.appsConfig, buildAppsPatch(s.appsConfig)); }
            } catch (e) { /* ignore */ }
        }
        state.patched++;
        if (state.patched === 1) {
            try { console.info(TAG, "已解除 Copilot 区域限制"); } catch (e) { /* ignore */ }
        }
    }

    function scanRouter() {
        var router = W.__TSR_ROUTER__;
        if (!router || !router.state) { return false; }
        var matches = router.state.matches || [];
        var hit = false;
        for (var i = 0; i < matches.length; i++) {
            var ctx = matches[i] && matches[i].context;
            if (ctx && ctx.store) {
                try { applyToStore(ctx.store); } catch (e) { /* ignore */ }
                hit = true;
            }
        }
        return hit;
    }

    /* ---------------------- 启动 ---------------------- */

    installTsrHook();
    installHydrationHook();

    var startedAt = Date.now();
    function tick() {
        var hit = false;
        try { hit = scanRouter(); } catch (e) { /* ignore */ }
        var fast = (Date.now() - startedAt) < OPTIONS.fastPollDurationMs;
        var delay = fast ? OPTIONS.fastPollMs : (hit ? OPTIONS.slowPollMs : 100);
        setTimeout(tick, delay);
    }
    tick();

    try {
        document.addEventListener("visibilitychange", function () {
            if (!document.hidden) { try { scanRouter(); } catch (e) { /* ignore */ } }
        });
        W.addEventListener("pageshow", function () {
            try { scanRouter(); } catch (e) { /* ignore */ }
        });
    } catch (e) { /* ignore */ }

    try {
        W.__M365RegionUnlock = {
            version: "3.0.0",
            options: OPTIONS,
            status: state,
            run: function () { return scanRouter(); },
            patchPayload: function (o) { return patchGraph(o); }
        };
    } catch (e) { /* ignore */ }
})();
