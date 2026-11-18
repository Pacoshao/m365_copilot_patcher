// ==UserScript==
// @name         M365 Copilot 区域限制解除
// @namespace    https://github.com/Pacoshao/m365_copilot_patcher
// @version      4.0.0
// @description  解除 Microsoft 365 Copilot 的区域限制，让聊天界面在受限地区可用（含左侧导航补全）
// @author       Pacoshao
// @match        https://m365.cloud.microsoft/*
// @match        https://copilot.cloud.microsoft/*
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

/*
 * 原理
 * ==================================================================
 * 区域受限时，站点会在 hydration 阶段由路由守卫抛 307，整页跳去搜索页
 * /search。守卫读取的是 SSR 内联下发的 streamed 路由载荷：
 *
 *   <script>self.$_TSR = {...}</script>
 *   <script>$_TSR.router = ($R => ($R[0] = {manifest, matches, dehydratedData}))(...)</script>
 *
 * 载荷里就带着判断所需的全部数据（实测）：
 *   x.eligibility.isCopilotEnabledRegion   区域是否开放
 *   x.eligibility.isCopilotEligible        账号是否具备资格
 *   x.appsConfig.isChatEligible            聊天入口开关
 *   x.coreAppsContent                      左侧导航条目（受限时只有 Search / Plugins）
 *
 * 所以在 document-start 把 window.$_TSR 改成访问器，等站点给 router 赋值
 * 的那一刻深挖整棵载荷，就地改写上述字段并补全导航条目。守卫拿到的
 * 已经是放行后的数据，跳转不会发生；导航也能一次渲染正确。
 * ==================================================================
 */

(function () {
    "use strict";

    var W = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;

    /* ^^^^^^^^^^^^^^^^^^^^^^^^^^ 可调参数 ^^^^^^^^^^^^^^^^^^^^^^^^^^ */
    var OPTIONS = {
        // 仅在载荷显示「区域受限」时才动手，正常账号不受干扰
        engageOnlyWhenRegionBlocked: true,

        // 需要一并点亮的应用开关
        unlockApps: [
            "isChatEligible",
            "isLibraryEligible",
            "isProjectsEligible",
            "isConversationsEnabled",
            "isAgentsEnabled"
        ],

        // 载荷深挖最大深度
        graphMaxDepth: 8,

        // 需要补全的左侧导航项。
        // 站点渲染规则：label 只有 1 个字符时，它把 id 当 key 去查自己的
        // 本地化文案；label 更长则原样显示。
        // chat 不能沿用官方 id（d870f6cd-…），否则会被截成单个「新」字。
        navItems: [
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

        debug: false
    };
    /* vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv */

    var TAG = "[M365区域解锁]";
    var state = {
        engaged: false,
        eligPatched: 0,
        appsPatched: 0,
        navPatched: 0,
        payloadSeen: 0,
        locale: null,
        lastHook: null
    };

    var ELIG_PATCH = {
        isCopilotEnabledRegion: true,
        isCopilotEligible: true,
        isOptedOutByAdmin: false,
        isError: false
    };

    function log() {
        if (!OPTIONS.debug) { return; }
        try {
            var a = Array.prototype.slice.call(arguments);
            a.unshift(TAG);
            console.log.apply(console, a);
        } catch (e) { /* ignore */ }
    }

    /* ---------------------- 单项修补 ---------------------- */

    function looksBlocked(e) {
        return !!e && (e.isCopilotEnabledRegion === false || e.isCopilotEligible === false);
    }

    function patchEligibility(e) {
        if (!e || typeof e !== "object") { return false; }
        if (e.isCopilotEnabledRegion === true && e.isCopilotEligible === true) { return false; }
        var keys = Object.keys(ELIG_PATCH);
        for (var i = 0; i < keys.length; i++) {
            if (e[keys[i]] !== ELIG_PATCH[keys[i]]) { e[keys[i]] = ELIG_PATCH[keys[i]]; }
        }
        return true;
    }

    function patchAppsConfig(a) {
        if (!a || typeof a !== "object") { return false; }
        var changed = false;
        for (var i = 0; i < OPTIONS.unlockApps.length; i++) {
            var k = OPTIONS.unlockApps[i];
            if (k in a && a[k] !== true) { a[k] = true; changed = true; }
        }
        return changed;
    }

    function isZh() {
        var loc = String(state.locale || "");
        if (/^zh/i.test(loc)) { return true; }
        if (loc) { return false; }
        try { return /^zh/i.test(navigator.language || ""); } catch (e) { return false; }
    }

    function patchNav(list) {
        if (!Array.isArray(list)) { return false; }
        var have = {};
        for (var i = 0; i < list.length; i++) {
            var it = list[i];
            if (it && it.id) { have[it.id] = true; }
        }
        var zh = isZh();
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
        if (!added.length) { return false; }
        for (var k = added.length - 1; k >= 0; k--) { list.unshift(added[k]); }
        state.navPatched += added.length;
        log("已补全导航：" + added.map(function (x) { return x.label; }).join("、"));
        return true;
    }

    /* ---------------------- 载荷深挖 ---------------------- */

    function patchGraph(root) {
        if (!root || typeof root !== "object") { return 0; }
        var seen = new WeakSet();
        var changed = 0;

        function walk(o, depth) {
            if (!o || typeof o !== "object" || depth > OPTIONS.graphMaxDepth || seen.has(o)) { return; }
            seen.add(o);

            try {
                if (typeof o.locale === "string" && o.locale.length <= 16 && !state.locale) {
                    state.locale = o.locale;
                }
                if (o.eligibility && typeof o.eligibility === "object") {
                    if (looksBlocked(o.eligibility)) { state.engaged = true; }
                    if (state.engaged && patchEligibility(o.eligibility)) {
                        state.eligPatched++; changed++;
                    }
                }
                if (state.engaged) {
                    if (o.appsConfig && typeof o.appsConfig === "object") {
                        if (patchAppsConfig(o.appsConfig)) { state.appsPatched++; changed++; }
                    }
                    if (Array.isArray(o.coreAppsContent)) {
                        if (patchNav(o.coreAppsContent)) { changed++; }
                    }
                }
            } catch (e) { /* ignore */ }

            var keys;
            try { keys = Object.keys(o); } catch (e) { return; }
            for (var i = 0; i < keys.length; i++) {
                var v;
                try { v = o[keys[i]]; } catch (e) { continue; }
                if (v && typeof v === "object") { walk(v, depth + 1); }
            }
        }

        walk(root, 0);
        return changed;
    }

    /* ---------------------- 唯一钩子 ---------------------- */

    function installHook() {
        try {
            var real;
            Object.defineProperty(W, "$_TSR", {
                configurable: true,
                enumerable: true,
                get: function () { return real; },
                set: function (v) {
                    state.payloadSeen++;
                    try {
                        real = new Proxy(v, {
                            set: function (target, key, value) {
                                if (key === "router") {
                                    try {
                                        var n = patchGraph(value);
                                        if (n) {
                                            console.info(TAG, "已解除区域限制（载荷修补 " + n + " 处）");
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

    installHook();

    try {
        W.__M365RegionUnlock = {
            version: "4.0.0",
            options: OPTIONS,
            status: state,
            patchPayload: function (o) { return patchGraph(o); }
        };
    } catch (e) { /* ignore */ }
})();
