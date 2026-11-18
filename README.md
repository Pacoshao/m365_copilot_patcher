# M365 Copilot 增强脚本

两个独立的油猴脚本：

| 文件 | 作用 |
| --- | --- |
| `m365-copilot-region-unlock.user.js` | 解除 Copilot Chat 的区域限制，并补全左侧导航 |
| `m365-copilot-model-memory.user.js` | 记住上次选的模型，不再每次回到「自动」 |

---

## 1. 区域限制解除

区域受限时，站点会在 hydration 阶段由 TanStack 路由守卫抛 307，整页跳去搜索页 `/search`。
守卫读取的是 SSR 内联下发的 streamed 路由载荷：

```html
<script>self.$_TSR = {...}</script>
<script>$_TSR.router = ($R => ($R[0] = {manifest, matches, dehydratedData}))(...)</script>
```

载荷里带着判断所需的全部数据，因此脚本只在 `document-start` 做一件事：
把 `window.$_TSR` 改成访问器，等站点给 `router` 赋值的那一刻深挖整棵载荷，就地改写。

| 字段 | 受限时 | 改为 |
| --- | --- | --- |
| `eligibility.isCopilotEnabledRegion` | `false` | `true` |
| `eligibility.isCopilotEligible` | `false` | `true` |
| `appsConfig.isChatEligible` 等 | `false` | `true` |
| `coreAppsContent` | 只有 `Search` / `Plugins` | 补上缺失的导航项 |

守卫拿到的已经是放行后的数据，跳转不会发生；导航也在首屏一次渲染正确。

### 左侧导航

补齐的入口：新建聊天 `/chat`、库 `/library`、工作区 `/projects`、智能体 `/agents`。
图标全部使用线上实际存在的官方资源。

两条站点渲染规则：

- **label 只有 1 个字符时**，站点把它当 key，用 id 去查自己的本地化文案；
  label 更长则原样显示。所以 Projects/Library 传单字符，由站点显示「工作区」「库」。
- **不能沿用官方 chat 的 id**（`d870f6cd-…`）：站点会认出它并套用自己的文案，
  中文下会被截成单个「新」字。换普通 id + 显式 label 即可。

### 实测

- 在真实受限账号上稳定停在 `/home`，输入框可用，能正常收发消息。
- 区域限制纯粹是前端门槛，服务端不拦截。

---

## 2. 记住模型选择

站点不记忆模型选择：每次刷新、每个新会话都回到「自动」。
选择状态只存在于选择器组件内部，不落 localStorage / cookie，也不在 store 里。
所以由脚本自己记、自己恢复。

做法：

1. 监听模型选择器按钮的 `aria-label`，用户一换模型就记进 localStorage。
2. 每次加载后若当前不是上次那个，就程序化点开菜单、必要时展开 GPT 子菜单、选中对应项。

技术要点：

- Fluent UI 菜单按钮不响应合成的 `dispatchEvent('click')`，但 React props 上挂着真实
  `onClick`，直接调用即可。
- GPT 分组是子菜单，需要再点一次分组项才会展开。
- 按钮显示名是 `shortTitle`（「GPT-5.6 Sol 思考」），菜单项是 `menuItemTitle`
  （「GPT-5.6 Sol 深度思考」），对不上，脚本会从 store 的 `modelSelectorMetadata` 做映射。

模型列表完全取自官方，脚本里没有任何写死的模型名：

| 数据 | 来源 |
| --- | --- |
| 可选模型清单 | `modelSelectorMetadata.availableModelSelectionOptions`（服务端下发，逐项展平 `itemGroup`）|
| 显示名 ↔ 菜单项名 | 同上的 `shortTitle` / `menuItemTitle` |
| 实际可点的项 | DOM 里的 `[role="menuitemradio"]` |

官方新增、下线或改名模型都不需要改脚本。

时序：进入页面后有偏好就恢复一次；没有偏好也立即转入正常记录；
程序化恢复期间暂停记录，避免把中间态写进偏好。

---

## 安装

1. 安装 Tampermonkey（篡改猴）或 Violentmonkey（暴力猴）。
2. 新建脚本，把对应 `.user.js` 的内容整个粘贴进去保存。
3. 打开 <https://m365.cloud.microsoft/> 或 <https://copilot.cloud.microsoft/> 并登录，刷新一次。

两个脚本可同时安装，`@match` 相同但职责不同。

## 注意事项

- 区域脚本只在载荷显示受限时才介入，正常账号不受干扰
  （改 `OPTIONS.engageOnlyWhenRegionBlocked` 可强制）。
- 模型脚本想清掉偏好用 `__CopilotModelMemory.clear()`。
- 都有 `OPTIONS.debug` 开关，控制台会打印判定和动作。

## 调试入口

```js
// 区域
__M365RegionUnlock.status    // { engaged, eligPatched, appsPatched, navPatched, payloadSeen, lastHook }
__M365RegionUnlock.patchPayload(obj)   // 手动对某个对象跑一次修补

// 模型
__CopilotModelMemory.read()   // 当前记住的偏好
__CopilotModelMemory.runtime  // { applying, restored, lastSeen, clicks }
__CopilotModelMemory.clear()  // 清除偏好
```

失效时按顺序排查：

1. `__M365RegionUnlock.status.lastHook` 应为 `tsr`、`payloadSeen` 大于 0；
   若为 `tsr-failed`，说明 `$_TSR` 这个入口变了。
2. 资格字段是否还叫 `eligibility.isCopilotEnabledRegion` / `isCopilotEligible`。
3. 模型脚本失效时，看选择器 `aria-label` 是否还是「xxx，模型选择器」。
