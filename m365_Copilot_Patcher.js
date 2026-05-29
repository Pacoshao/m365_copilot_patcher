// ==UserScript==
// @name        m365 Copilot Patcher
// @namespace   Violentmonkey Scripts
// @match       https://m365.cloud.microsoft/*
// @grant       none
// @run-at      document-start
// @version     1.1
// @author      Pacoshao
// @description 3/15/2026, 7:54 PM
// ==/UserScript==
//

let myData = window.__staticRouterHydrationData;

Object.defineProperty(window, '__staticRouterHydrationData',{
  enumerable: true,
  configurable: true, // 允许后续再次修改
  get() {
    console.log('正在读取 __staticRouterHydrationData');
    //console.log(myData);
    return myData;
  },
  set(value) {
    console.log('正在设置 __staticRouterHydrationData', value);
    myData = value;
    myData.loaderData.root.store.eligibility.isCopilotEnabledRegion = true;
    myData.loaderData.root.store.eligibility.isCopilotEligible = true;
    myData.loaderData.root.store.eligibility.copilotAdminPinSetting = "Pinned";
    myData.loaderData.root.store.eligibility.acquisitionState = "acquired";
    const existing = myData.loaderData.root.store.coreAppsContent ?? [];

    const toAdd = [
        { id: "d870f6cd-4aa5-4d42-9626-ab690c041429", label: "New chat", path: "/chat" },
        { id: "Search", label: "Search", path: "/search" },
        { id: "Library", label: "Library", path: "/library" },
        { id: "83d3f491-b586-4266-8738-89776471bf21", label: "Create", path: "/create" }
    ].filter(item => !existing.some(e => e.label == item.label));

    myData.loaderData.root.store.coreAppsContent = [...existing, ...toAdd];
  }
});
