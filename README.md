# M365 Copilot 增强脚本

两个独立的油猴脚本，分别解决「区域限制」和「模型选择不记忆」：

| 文件 | 作用 |
| --- | --- |
| `m365-copilot-region-unlock.user.js` | 解除 Copilot Chat 的区域限制 |
| `m365-copilot-model-memory.user.js` | 记住上次选的模型，不再每次回到「自动」 |

旧的 `m365 Copilot Patcher.user.js` 已失效，仅留作对照。

---

## 1. 区域限制解除

### 当前站点是怎么拦的（2026-11-18）

区域受限时，站点不再停在「Copilot Chat 不可用」页，而是**整页跳转到搜索页** `/search`。
跳转来自 TanStack 路由守卫：hydration 阶段发现账号不合格，抛一个 307 重定向。

两个曾经尝试、但都改不动的位置：

| 位置 | 结果 |
| --- | --- |
| zustand store（`__TSR_ROUTER__`） | 出现得太晚，守卫早已跑完，改了不起作用 |
| `window.__staticRouterHydrationData` | 实测改了照样被踢走 |

真正被守卫读取的，是 SSR 内联下发的那段 **streamed 路由载荷**：

```html
<script>self.$_TSR = {...}</script>
<script>$_TSR.router = ($R => ($R[0] = {manifest:…, matches:…, dehydratedData:…}))(...)</script>
```

所以脚本的核心是在 `document-start` 把 `window.$_TSR` 改成访问器，
在站点给 `router` 赋值的那一刻深挖整棵载荷对象，就地改写：

| 字段 | 受限时 | 改为 |
| --- | --- | --- |
| `eligibility.isCopilotEnabledRegion` | `false` | `true` |
| `eligibility.isCopilotEligible` | `false` | `true` |
| `appsConfig.isChatEligible` 等 | `false` | `true` |

守卫拿到的就已经是放行后的数据，因此**不会触发跳转**。

另保留两层兜底：store 轮询（防止站点回源刷新资格后又被锁）、老的水合数据钩子。

### 左侧导航补全

区域受限账号拿到的 `coreAppsContent` 只有 `Search` / `Plugins`，
连「新建聊天」都没有——这些入口是服务端按区域资格裁剪掉的。
脚本解锁后会按站点自己的数据结构把缺失项补进 store，导航随即渲染：
新建聊天 `/chat`、库 `/library`、工作区 `/projects`、智能体 `/agents`。
图标全部使用线上实际存在的官方资源（逐个探测过）。

两个实测出来的渲染规则：

- **label 只有 1 个字符时**，站点认为它是 key，会拿 id 去查自己的本地化文案；
  label 更长时则原样显示。所以 Projects/Library 传单字符，交给站点显示「工作区」「库」。
- **不能沿用官方 chat 的 id**（`d870f6cd-…`）：站点会认出它并套用自己的文案，
  而那份文案在当前构建下会被截成单个「新」字。换个普通 id + 显式 label 即可。

补全每次轮询都会校验，站点重新拉数据把导航刷回受限版时会自动补回。

### 实测结论

- v3 在真实受限账号上稳定停在 `/home`，输入框可用，能正常收发消息。
- 区域限制纯粹是前端门槛，服务端不拦截。

---
## 2. 记住模型选择

站点**不会记住**模型选择：每次刷新、每个新会话都回到「自动」。
实测确认选择状态既没写进 localStorage / sessionStorage / cookie，
也不在 zustand store（`gptMode` 恒为 `"auto"`），只存在于选择器组件内部，
随每次加载重置。所以只能由脚本自己记、自己恢复。

做法：

1. 监听模型选择器按钮的 `aria-label`，用户一换模型就记进 localStorage。
2. 每次加载后若当前不是上次那个，就程序化点开菜单、必要时展开 GPT 子菜单、
   选中对应项。

**技术要点：**

- Fluent UI 的菜单按钮**不响应**合成的 `dispatchEvent('click')`（实测点不开），
  但 React props 上挂着真实 `onClick`，直接调用即可。
- GPT 分组是子菜单，需要再点一次分组项才会展开出
  「GPT-5.6 Sol 快速响应 / 深度思考」。
- 按钮显示名是 `shortTitle`（如「GPT-5.6 Sol 思考」），菜单项是 `menuItemTitle`
  （「GPT-5.6 Sol 深度思考」），两者对不上，脚本会从 store 的
  `modelSelectorMetadata` 里做映射。

**模型列表完全取自官方，脚本里没有任何写死的模型名：**

| 数据 | 来源 | 说明 |
| --- | --- | --- |
| 可选模型清单 | `modelSelectorMetadata.availableModelSelectionOptions` | 服务端下发，脚本逐项展平 `itemGroup` 得到 |
| 显示名 ↔ 菜单项名映射 | 同上的 `shortTitle` / `menuItemTitle` | 解决「GPT-5.6 Sol 思考」与「GPT-5.6 Sol 深度思考」对不上 |
| 实际可点的菜单项 | DOM 里的 `[role="menuitemradio"]` | 以打开菜单后真实渲染出来的为准 |

所以官方新增、下线或改名模型都不需要改脚本。官方改名后若显示名对不上，
脚本会退回「包含匹配」再试一次，仍然只在官方当前列表里找，不引入本地常量。

**记录与恢复的时序（容易出错的地方）：**

1. 进入页面 → 若已有偏好，尝试恢复**一次**；若没有偏好，也要把
   「已尝试恢复」置真后立即转入正常记录。
2. 之后进入监听：常驻运行，不设截止时间——刷新后你随时手动换模型都能记住。
3. 程序化恢复期间暂停记录，避免把中间态写进偏好。

初次写这个脚本时踩过一个坑：把「没有偏好就直接返回」和「未尝试恢复就不许记录」
两个条件放在一起，会让**全新用户**永远记不住第一次手动选择（死锁）。
现在改成按「是否已尝试过恢复」判断，而不是按「是否存在偏好」判断。

**已验证场景：**

- 全新用户（无偏好）首次手动选「深度思考」→ 立即被记录 → 刷新恢复 ✅
- 选「GPT-5.6 Sol 思考」→ 刷新 → 自动恢复 ✅
- 从「深度思考」换到「GPT-5.6 Sol 思考」→ 刷新 → 自动恢复 ✅
- 连续刷新三次 → 稳定保持，偏好不被覆盖 ✅

---

## 安装

1. 安装 Tampermonkey（篡改猴）或 Violentmonkey（暴力猴）。
2. 新建脚本，把对应 `.user.js` 的内容整个粘贴进去保存。
3. 打开 <https://m365.cloud.microsoft/> 或 <https://copilot.cloud.microsoft/> 并登录，
   刷新一次即可。

两个脚本可同时安装，互不干扰（`@match` 相同，职责不同）。

## 注意事项

- 区域脚本只在检测到受限时才介入，正常账号不受干扰
  （改 `OPTIONS.engageOnlyWhenRegionBlocked` 可强制）。
- 模型脚本首次运行时会先记录一次当前选择；想清掉用
  `__CopilotModelMemory.clear()`。
- 都有调试开关：把对应脚本里的 `OPTIONS.debug` 改成 `true`，
  控制台会打印判定和动作。

## 调试入口

```js
// 区域
__M365RegionUnlock.status          // { engaged, patched, lastHook }
__M365RegionUnlock.run()           // 手动触发一次修补

// 模型
__CopilotModelMemory.read()        // 当前记住的偏好
__CopilotModelMemory.runtime       // { applying, restored, lastSeen, clicks }
__CopilotModelMemory.clear()       // 清除偏好
```

微软随时可能改字段名或改成服务端校验。若失效，按顺序看两处：

1. 路由载荷是否还是 `$_TSR.router`：
   `__M365RegionUnlock.status.lastHook` 应为 `tsr`，`payloadHits` 应大于 0。
2. 资格字段是否还叫这些名字：
   `__TSR_ROUTER__.state.matches[0].context.store.getState().eligibility`。

模型脚本失效时，看模型选择器的 `aria-label` 是否还是「xxx，模型选择器」。