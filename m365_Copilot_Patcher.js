// ==UserScript==
// @name        m365 Copilot Patcher
// @namespace   Violentmonkey Scripts
// @match       https://m365.cloud.microsoft/*
// @grant       none
// @run-at      document-start
// @version     1.2
// @author      Pacoshao
// @description 7/19/2026
// ==/UserScript==
//


(function () {
    function patchData(data) {
        if (!data?.loaderData?.root?.store) {
            return;
        }

        const store = data.loaderData.root.store;

        if (store.eligibility) {
            store.eligibility.isCopilotEnabledRegion = true;
            store.eligibility.isCopilotEligible = true;
            store.eligibility.acquisitionState = "acquired";
        }

        const existing = store.coreAppsContent || [];

        const toAdd = [
            {
                "id": "d870f6cd-4aa5-4d42-9626-ab690c041429",
                "label": "New chat",
                "path": "/chat",
                "iconSrc": "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/m365copilotresources/apps/bebop-chats.svg",
                "selectedIconSrc": "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/m365copilotresources/apps/bebop-chats-filled.svg",
                "coloredSelectedIcon": false
            },
            {
                "id": "Search",
                "label": "Search",
                "path": "/search",
                "iconSrc": "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/m365copilotresources/apps/search.svg",
                "selectedIconSrc": "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/m365copilotresources/apps/bebop-search-filled.svg",
                "coloredSelectedIcon": false
            },
            {
                "id": "Library",
                "label": "Library",
                "path": "/library",
                "iconSrc": "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/m365copilotresources/apps/library.svg",
                "selectedIconSrc": "https://res.public.onecdn.static.microsoft/midgard/versionless-v2/m365copilotresources/apps/bebop-library-filled.svg",
                "coloredSelectedIcon": false
            }
        ].filter(
            item => !existing.some(
                e => e.label === item.label
            )
        );

        store.coreAppsContent = [
            ...existing,
            ...toAdd
        ];
    }

    let currentData = window.__staticRouterHydrationData;

    if (currentData) {
        patchData(currentData);
    }

    Object.defineProperty(
        window,
        "__staticRouterHydrationData",
        {
            configurable: true,
            enumerable: true,

            get() {
                return currentData;
            },

            set(value) {
                currentData = value;

                try {
                    patchData(currentData);
                } catch (e) {
                    console.error(e);
                }
            }
        }
    );
})();
