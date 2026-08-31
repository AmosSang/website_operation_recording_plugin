# Journey Recorder（交互旅程录制器）

> PM 在真实系统里把一个功能「演」一遍（可多遍、多角色），插件自动产出：**可回放的操作现场 + 每步证据包（截图 / DOM / 接口）+ 供 AI 反推使用文档、功能描述、接口规格和 HTML 仿写原型的全部素材。**
>
> Chrome 扩展（Manifest V3），纯本地运行，数据不出网。

---

## 目录

- [产品是什么](#产品是什么)
- [核心功能](#核心功能)
- [安装方式](#安装方式)
- [使用方式](#使用方式)
- [技术实现](#技术实现)
- [导出文件格式](#导出文件格式)
- [manifest.json 契约](#manifestjson-契约)
- [开发与测试](#开发与测试)
- [已知局限](#已知局限)
- [开源协议](#开源协议)

---

## 产品是什么

维护内部系统（如配奇 ICS3.0、学而思素养等）的产品知识时，传统做法是「人工报层级路径 + AI 驱动浏览器逐步采集截图/DOM/CSS/接口」。实测有三个痛点：

1. **效率低**：采一个详情页 + 9 个子模块约 35 分钟；
2. **覆盖靠人驱动**：每一步都要人描述「点什么」，人的操作行为本身没被利用；
3. **组织方式错位**：按文件夹层级归档，丢掉了「功能是怎么一步步用起来的」这条主线——而这恰是写使用文档、反推 PRD、仿写原型最需要的信息。

**Journey Recorder 的解法**：把「录制用户真实操作路径 + 每步留证」组合成一个 PM 视角的知识库工具。

- **主组织方式**：操作路径（Journey → Step 树），不用文件夹层级；产品层级索引是 AI 的派生产物。
- **人机分工**：人负责操作（开车），插件负责确定性抓取（行车记录仪），AI 负责录制后的语义分析（文档 / 规格 / 原型）。

### 目标（v0.1 验收口径）

| #  | 目标                       | 度量                          |
| -- | ------------------------ | --------------------------- |
| G1 | 效率：配奇详情页 + 9 子模块同一路径含导出 ≤ 10 分钟 | 计时走查（基线 35 分钟）      |
| G2 | 完整性：路径上每个有效点击有截图 + DOM + 接口轨迹三件套，零遗漏 | 抽查 20 步                    |
| G3 | 可消费：manifest.json 稳定到 AI 能据此自动生成 L0 使用手册 | 试验报告（人工补充率 < 20%） |
| G4 | 安全：请求头 / 请求体 token 类敏感信息 100% 脱敏后落盘 | 抽查脱敏清单                |

### 非目标（明确不做）

- ❌ 云端存储与团队协作平台（v1+ 再议）
- ❌ 自动化回放执行（那是 Playwright 类 QA 工具的事）
- ❌ 替代埋点 / 行为分析平台（不做统计聚合）
- ❌ Firefox / Safari（v0.1 仅 Chrome ≥ 120）
- ❌ 修改被测系统的任何数据（插件只读页面 + 写本地文件）
- ❌ 插件内的实时语音转写（见 [技术实现 → 口述轨](#口述轨只录不转写)）

---

## 核心功能

### 1. 操作轨迹录制（Journey → Step）
- 录制期间每一次**有效交互**（默认左键 click）都会锚定成一个 **Step**，自动命名：`003_click[新建大纲文件夹]`。
- 支持文本输入（blur/Enter 汇总）、select / checkbox / radio 的 change 即锚定；密码恒显示为 `***`。
- 支持**手动锚点**：遇到不好捕捉的页面变化（弹窗、长加载），在 popup 点「＋ 在此添加锚点」补一个解说节点。

### 2. 每步证据包（三件套）
每个 Step 结算后自动产出：

| 证据 | 说明 |
| ---- | ---- |
| **截图** | 视口截图（PNG，超 5MB 降级 JPEG85） |
| **DOM 快照** | 结算瞬间的整棵 DOM 冻结态（`outerHTML`），可直读喂 AI |
| **接口轨迹** | 该步触发的全部 fetch/XHR：method、URL、status、耗时、请求/响应体 |

### 3. 双证据策略（D7）
- **通道 A｜rrweb 事件流**：录制开始全量 DOM 快照，此后全程增量 mutation 流，导出为 `rrweb/events.jsonl`，驱动离线回放器。
- **通道 B｜每步全量 outerHTML 快照**：直读证据，喂 AI 消费。
- **互为备份**：A 保「全过程可回放」，B 保「单点可直读」；某步取证失败不影响回放还原。

### 4. 结算机制（Settle）
锚定与取证分离——**锚定立即，取证等页面稳定**。三信号齐（DOM 静默 300ms + 网络全返回 + 路由静止 300ms）才截图取证：

- 页面正常变完 → `settled`（理想路径）
- 用户没等就做了下一步 → `interrupted_settle`（立即取证，缺失的最终态由后续步骤补齐，全链零丢失）
- 页面一直不变 / 接口挂起 → `settle_timeout`（10s 兜底，「点了没反应」本身是宝贵的需求现场证据）

### 5. 标签页链（S7.1）
录制中点击按钮打开**新标签页**，新 tab 自动纳入录制链并补一次初始快照（`NNN_tab_open[页面标题]`），可跨页继续操作、连续留证。多标签页的步骤交错编号并带 `tab_id`。

### 6. 口述轨（F10，只录不转写）
- popup 开「🎤 录音」+ 授权后，**同步录下你的解说**，导出为 `audio/journey.webm` + `audio/timeline.json`。
- 录音在 **offscreen document** 中进行，**不随 popup 关闭、页面跳转而中断**。
- **转写不在插件内**：录制后由 AI 用本地 whisper.cpp 分段回填 `manifest.transcripts[]` 并合并进对应 Step 的 `user_note`（Web Speech API 会把音频发往 Google，直接排除）。

### 7. 页面资源抓取（S8，高保真仿制）
录制 DOM 时，把**每个页面**的一套资源一并导出，供 AI 高保真仿制可交互原型：
- **外链 CSS 正文**内联进 `<style>`（不只是一条 `<link>` 记录）；
- **相对路径 CSS** 按入口页 base URL 解析成绝对地址再下载；
- CSS 里的 `url()` 外部资源（SVG/PNG/字体）下载并转 `data:base64` 或落到 `assets/`，改写引用；
- `@font-face` 字体内联。
- **按页面去重**：每页一套（`pages/<page_id>/`），不绑每个 Step，避免重复内联同一套资源撑大体积。

### 8. 安全与脱敏（F5）
- 网络钩子运行于 MAIN world，hook `window.fetch` 与 `XMLHttpRequest`；
- 请求头**白名单外全丢**，必删 `beibotoken`/`authtoken`/`cookie`/`authorization` 及 JWT（`eyJ` 三段式）；
- body 键名含 `password`/`token`/`secret`/`auth`/`key` 的值替换为 `***`；
- **脱敏在写入 IndexedDB 前完成**，原始数据不留痕。

---

## 安装方式

### 加载为开发者扩展（未打包）

> 适合当前 v0.1 开发阶段。

1. 下载 / 克隆本仓库，解压；
2. 打开 Chrome，进入 `chrome://extensions`；
3. 右上角打开 **「开发者模式」**；
4. 点 **「加载已解压的扩展程序」**，选择仓库里的 `journey-recorder/` 目录；
5. 扩展出现在工具栏，点右上角拼图图标 → 固定 `Journey Recorder`。

### 要求
- **Chrome ≥ 120**（依赖 `chrome.offscreen` API）。
- 录制内网系统需已在浏览器里**登录**（content script 继承登录态抓取资源）。

---

## 使用方式

### 基本流程（核心场景 A：知识库建设）
1. 打开要录制的系统页面，登录；
2. 点扩展图标，点 **「● 开始录制」**（支持开 🎤 录音）；
3. 正常把功能「演」一遍——列表→筛选→编辑→保存；
4. 点 **「■ 停止录制」** = 停止并导出；
5. 浏览器下载 `~/Downloads/JourneyRecorder/Journey_xxx_日期.zip`；
6. 把 zip 丢给 AI，AI 基于 [manifest.json 契约](#manifestjson-契约) 产出该功能的文档 / 规格 / 原型。

### 进阶
- **＋ 在此添加锚点**：录制中手动补一个解说节点（弹窗、长加载等）。
- **🎤 麦克风**：开启后同步录音（先在 `chrome://extensions` 详情页「网站设置」里把麦克风预授权为「允许」，否则询问态不弹窗）。
- **每步 DOM 快照**：开关（默认开）；长行程可关闭省体积。
- **打开新标签页**：点按钮开新 tab，插件自动纳入链并连录。

---

## 技术实现

### 架构分层

```
┌─ Chrome 扩展（MV3）────────────────────────────────────┐
│  ① 注入层 content script（ISOLATED + MAIN 双世界）       │
│     · 锚定：click / change / 手动锚点监听与定位描述符      │
│     · Settle 结算状态机（DOM 静默 + 网络静默 + 路由静止）  │
│     · fetch/XHR hook（MAIN world，postMessage 桥回）    │
│     · domsig 定位描述符 + sanitizer 脱敏                 │
│     · 页面资源采集（外链 CSS/字体/图片，带登录态 fetch）    │
│  ② 后台层 service worker（orchestrator）                 │
│     · 录制状态机 · IndexedDB 单一写入口（D6）            │
│     · 标签页链管理 · 截图（captureVisibleTab）           │
│  ②b Offscreen layer（单 document 承载双职）              │
│     · 音频捕获 MediaRecorder（F10）                     │
│     · 打包导出 JSZip → downloads API（D5）             │
│  ③ UI 层 popup                                          │
│     · 开始 / 停止并导出 · 麦克风开关 DOM 快照开关         │
└───────────────────────────────────────────────────────┘
```

### 三条数据管道
1. **锚定管道**：click / change / manual / tab_open 事件 → Step 元数据（立即落库）；
2. **rrweb 事件流**：全量 DOM 快照 + 增量 mutation，分片转发，驱动回放器；
3. **网络钩子**：fetch/XHR 轨迹，脱敏后逐条入库。

### 关键技术决策（D 系列）
| #  | 决策 | 缘由 |
| -- | ---- | ---- |
| D1 | rrweb.record 为录制内核，直接进 v0.1 | 跑在 ISOLATED world 即可用，只读 DOM + MutationObserver，不碰页面 JS |
| D2 | fetch/XHR hook 注入 MAIN world | 页面自己的 `window.fetch` 只有 MAIN world 能截到 |
| D3 | 定位描述符在点击瞬间同步计算 | 目标元素随时可能被框架卸载，事件时才是唯一可靠时机 |
| D4 | 插件只产原始信号字段，语义标签由 AI 派生 | 插件侧语义判断误判率高；契约只增不改删 |
| D5 | JSZip 组包放 offscreen document | MV3 SW 没有 `URL.createObjectURL` |
| D6 | IndexedDB 单一写入口（SW） | 单写者避免竞态；DevTools 可直接查 IDB |
| D7 | 双证据：rrweb 事件流 + 每步 outerHTML 并存 | 互为备份（回放 vs 直读） |
| D8 | 截图时机 = 结算时刻，校验 tabId 活跃 | captureVisibleTab 须在画面正确瞬间执行 |
| D9 | 同步录音走 offscreen MediaRecorder 只录不转写 | 插件保持薄、零出网（Web Speech API 排除） |
| D10 | 录音时钟全链 `Date.now()`，首 chunk = t0 | 语音段落与 Step 的对齐依据 |

### 核心依赖（vendor 锁定）
| 库 | 版本 | 用途 |
| -- | ---- | ---- |
| [rrweb](https://github.com/rrweb-io/rrweb) | 2.1.1 | DOM 快照 + 增量录制 |
| [rrweb-player](https://github.com/rrweb-io/rrweb) | 2.1.1 | 离线回放器 |
| [JSZip](https://stuk.github.io/jszip/) | 3.10.1 | 打包导出 zip |

### 口述轨（只录不转写）
- **录**：offscreen document 内 `MediaRecorder(audio/webm;codecs=opus)`，chunk 每 2s 入 IndexedDB，生命周期不随 popup 关闭/页面跳转中断。
- **存**：`audio/journey.webm` + `audio/timeline.json {t0, endMs, mimeType}`。
- **写**：**不在插件内**。AI 用本地 whisper.cpp 分段 `[startMs,endMs,text]`，按 D10 时钟契约回填 `manifest.journey.transcripts[]` 并合并进对应 Step 的 `user_note`。Web Speech API 因音频出网被明确排除；实时 WASM 转写因内存/CPU 代价 v0.1 不做。

---

## 导出文件格式

「停止并导出」后得到单个 zip，落于 `~/Downloads/JourneyRecorder/`。内部布局：

```
Journey_总部大纲详情页走查_20260827/
├── manifest.json              # 旅程清单（插件 ↔ AI 契约，见下节）
├── net/
│   └── calls.jsonl            # 全部脱敏后的接口记录（逐行 JSON）
├── rrweb/
│   └── events.jsonl           # 回放事件流（含 journey-step 锚点 customEvent）
├── audio/                     # 口述轨（未开录音则无此目录）
│   ├── journey.webm           # 录音（webm/opus）
│   └── timeline.json          # {t0, endMs, mimeType}
├── steps/                     # 每步证据包
│   ├── 001_click[编辑大纲内容]/
│   │   ├── viewport.png       # 该步视口截图
│   │   └── dom.html           # 该步结算瞬间 DOM 快照
│   ├── 004_input[搜索大纲ID]/
│   │   └── ...
│   └── ...
├── pages/                     # 每页一套资源（S8 高保真仿制）
│   └── p_<pageId>/
│       ├── page.html          # 外链 CSS 内联 + url() 转 base64 的完整页
│       ├── assets.css         # 该页全部 CSS 合并
│       └── assets/            # 图片 / 字体等二进制资源留档
├── player.html                # 离线回放器（双击打开，无需插件与网络）
└── README.txt                 # 自动生成的包说明（schema 版本、脱敏声明、局限）
```

---

## manifest.json 契约

插件与 AI 之间的**主契约**，字段稳定性最高优先级。约定：**已有字段永不改义、只增不改删；`schema_version` 变更时提供迁移说明。**

```jsonc
{
  "schema_version": "0.1",
  "journey": {
    "name": "总部大纲详情页走查",
    "recorded_at": "2026-08-27T18:30:00+08:00",
    "app": {
      "name": "配奇",
      "version_from_page": "V9.0.1.40",
      "entry_url": "...",
      "domains": ["sszt-yunting.speiyou.com"]
    },
    "settings": {
      "fullpage_screenshot": false,
      "per_step_dom_snapshot": true,
      "mic_enabled": false,
      "body_mask_keys": ["password", "token", "secret", "auth", "key"]
    },
    "audio": { "recorded": false, "t0": null, "endMs": null, "file": null },
    "transcripts": []           // AI 后处理回填：[{startMs, endMs, text, stepId}]
  },
  "pages": [                    // S8：每页一套资源的索引
    {
      "page_id": "p_...",
      "url": "...#/loc/newFaceClass",
      "title": "配奇",
      "page_html": "pages/p_.../page.html",
      "assets_css": "pages/p_.../assets.css"
    }
  ],
  "steps": [
    {
      "id": 3,
      "name": "003_click[新建大纲文件夹]",
      "action": "click",
      "timestamp_ms": 1787890000000,
      "rel_prev_ms": 4200,
      "target": {
        "css_path": "div.root > ... > button:nth-of-type(2)",
        "semantic": "button[role=button][text=新建大纲文件夹]#same-siblings-1",
        "visible_text": "新建大纲文件夹",
        "tag": "button", "aria_role": null, "aria_label": null
      },
      "page": { "url": "...#/loc/newFaceClass", "title": "配奇" },
      "page_id": "p_...",       // S8：标注该步所属页面资源
      "tags": ["modal_opened"],
      "artifacts": {
        "viewport_png": "steps/003/viewport.png",
        "fullpage_png": null,
        "dom_html": "steps/003/dom.html"
      },
      "api_calls": ["net/calls.jsonl#L120-L124"],
      "user_note": ""
    }
  ]
}
```

---

## 开发与测试

### 目录结构
```
journey-recorder/
├── manifest.json                # MV3 清单（权限 + privacy_justification）
├── background/
│   ├── orchestrator.js          # 录制状态机 + 消息路由 + 截图 + 标签页链
│   ├── stores.js                # IndexedDB 单写入口（journeys/steps/netCalls/rrEvents/audio/pageAssets）
│   ├── naming.js                # Step 命名（click/change/manual/tab_open）
│   ├── manifest-builder.js      # F6 契约组装 + 冒烟校验（UMD 可单测）
│   ├── pack-builder.js          # 组包纯函数（JSONL 展平/api_calls 行号/README）
│   └── resource-builder.js      # 页面资源解析/内联纯函数（UMD 可单测）
├── content/
│   ├── recorder.js              # 锚定 + Settle + 事件流 + 资源采集
│   ├── domsig.js                # 定位描述符（css_path + semantic，UMD 可单测）
│   ├── sanitizer.js             # 脱敏（头/体/JWT/递归掩码，UMD 可单测）
│   └── net-hook-main.js         # MAIN world fetch/XHR hook
├── offscreen/
│   ├── audio.html               # 单 offscreen document 承载录音 + 导出双职
│   ├── audio-capture.js         # MediaRecorder 音频捕获
│   ├── exporter.js              # 读 IDB → JSZip 组包 → downloads 落盘
│   └── player-template.html     # 回放器模板（数据占位符注入）
├── popup/                       # UI（开始/停止/麦克风/DOM 快照/手动锚点）
├── fixtures/demo-app/           # 夹具服务器（开发测试用，正式交付不含）
├── vendor/                      # rrweb / rrweb-player / jszip（锁定版本）
├── icons/icon128.png
└── tests/                       # node --test 单测
```

### 运行单测
```bash
cd journey-recorder
node --test tests/domsig.test.js tests/naming.test.js tests/sanitizer.test.js \
  tests/manifest.test.js tests/pack.test.js tests/resource.test.js
```
> ⚠️ 注意：`node --test` 传目录在本机 node 会异常，需显式列文件。

当前 **66 例全绿**（domsig 10 / naming 9 / sanitizer 21 / manifest 9 / pack 10 / resource 7）。

### 夹具服务器（仅开发测试）
内置一个演示用夹具服务器，模拟真实系统的交互与接口（含慢接口、挂起接口、新标签页），供开发测试：

```bash
cd journey-recorder/fixtures/demo-app
python3 server.py        # → http://127.0.0.1:8899/
```

---

## 已知局限

（登记进导出包 `README.txt`，消费端以此为据。）

- **跨域样式表回放失真**：rrweb 对跨域样式表的 `cssRules` 读取受浏览器安全策略限制，自带降级（记 href 占位）。回放时跨域样式可能失真，**证据仍以截图 + DOM 为准**。配奇类同源样式系统实测不受影响。
- **跨域 CDN 资源抓取**：页面资源的抓取依赖 content script 的 fetch（继承登录态）。跨域 CDN 资源若页面能加载则大概率能抓到；万一抓取失败，`pages` 段会登记 `sheets_missing`。
- **无缝跨标签页连续回放**：多个标签页是各自独立的 rrweb 录制会话，回放器单实例只能放单会话。回放时切换步骤会自动切到该步所在标签页的流。
- **iframe**：仅支持同源 iframe 递归快照；跨域内容在 manifest 标注 `unsupported_frame`。
- **50 步体积预警**：同一旅程超 50 步时弹黄牌提醒（不阻塞），可关 `per_step_dom_snapshot` 省体积。
- **v0.1 未做**：整页截图（依赖 `chrome.debugger`，预留开关默认关）、插件内实时转写、多用户协作。

---

## 开源协议

[MIT](./LICENSE) © 2026 AmosSang（https://github.com/AmosSang）

详见 [LICENSE](./LICENSE) 文件。
