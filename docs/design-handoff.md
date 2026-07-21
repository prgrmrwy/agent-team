# agent-team 前端设计 handoff

> 这份文档是给**未来做组件实现的人/AI**看的。读完它 + 看一遍
> [`design-mockup.html`](./design-mockup.html)（canonical 视觉参考），
> 应该能照着把任意页面/组件写出来不偏。
>
> 任何冲突：**mockup 文件赢，文档其次**。

---

## 1. 主体定位（don't forget what we're designing）

- 单用户、本地 Web 工具。
- 主操作场景：**每个 task 一个 chatroom**，chatroom 是该任务的唯一入口；
  artifact / state / specs / 人类干预全部从这里进出。
- 任务之间是**切换**关系，不是**并排观察**关系——刻意不做 fleet view / 多任务汇总仪表盘。
- 用户既是产品的**唯一使用者**，也是 chatroom 里**唯一的人类角色**（白色 Link 头像，永远视觉最亮）。

## 2. 视觉方向（one line）

**塞尔达·旷野之息 的双重视觉寄存器**：

| 寄存器 | 适用范围 | 质感 |
|---|---|---|
| **Sheikah Slate** | 全站 chrome、聊天、HUD、状态、菜单 | 深青蓝底 + cyan 磷光描边 + 蜂窝六边形暗纹 |
| **Hyrule Parchment** | artifact / markdown / 长文阅读 | 暖米黄羊皮纸 + 棕色衬线字 + ✦ 列表点 |

两个寄存器并存、对比强烈，**模拟"夜里在石屋点蜡烛读地图"的氛围**。
这是这套设计的签名识别度，不要为了"统一"把右栏也切成深色。

## 3. Design tokens

### 3.1 Color（CSS custom properties，与 mockup 文件一致）

**Sheikah slate / chrome**

| token | hex | 用途 |
|---|---|---|
| `--slate-bg` | `#0c1418` | 整页底色 |
| `--slate-surface` | `#131e25` | 面板底 |
| `--slate-elev` | `#1a2832` | 抬起表面（hover / 强调） |
| `--slate-edge` | `#243744` | 1px 分隔线 |
| `--slate-divide` | `rgba(91,200,221,0.18)` | 极淡 cyan 分隔 |

**Sheikah glow（强调/HUD）**

| token | hex | 用途 |
|---|---|---|
| `--cyan` | `#5bc8dd` | 默认强调色（边、文字、icon） |
| `--cyan-bright` | `#7eecff` | hover / 高亮 / 当前 state |
| `--cyan-dim` | `#2d6d7c` | 已过/弱化 |
| `--cyan-glow` | `rgba(91,200,221,0.55)` | `box-shadow` / `text-shadow` |
| `--amber` | `#ff8c2e` | 注意 / 激活的 Guardian rune |
| `--gold` | `#e8b028` | 奖励 / Korok 种子 / ci 角色色 |
| `--malice` | `#b83a5a` | blocked / 危险（极少用） |

**Ink（文字）**

| token | hex | 用途 |
|---|---|---|
| `--ink-white` | `#e6edf0` | 主要文字 |
| `--ink-soft` | `#b3c3ca` | 次要文字 |
| `--ink-dim` | `#6b808a` | 时间戳 / 元信息 |
| `--ink-dimmer` | `#45565f` | 占位 / 禁用 |

**Champion 角色调色板（每个 role 一种身份色，不可乱用）**

| role | token | hex | 怪物 |
|---|---|---|---|
| planner | `--planner` | `#6abae8` | Wizzrobe（米法蓝） |
| engineer | `--engineer` | `#f08544` | Moblin（达尔克橙） |
| qa | `--qa` | `#8fc758` | Octorok（里巴尔绿） |
| anti | `--anti` | `#d05878` | Lynel（乌尔波萨玫） |
| ci | `--ci` | `#e8b028` | Guardian（Sheikah 金） |
| pm-ux | `--pmux` | `#a896e0` | Korok（柯洛克紫） |
| **YOU** | `--link` | `#88c563` | Link（林克绿，带 `--link-glow`） |

**铁律：role 色仅用于"该角色的身份标记"**——头像描边/icon、消息署名色、seats 圆点、左栏 task 当前发言点。其他场景一律不要用 role 色。

**Hyrule parchment（仅用于右栏 artifact viewer）**

| token | hex | 用途 |
|---|---|---|
| `--paper` | `#ead8a8` | 羊皮纸底 |
| `--paper-edge` | `#c9b170` | 卷轴 header/footer 浅棕 |
| `--paper-shadow` | `#9c7e3f` | 装饰边 / hr |
| `--paper-deep` | `#6b4f1f` | h2 小写大写文字 |
| `--ink-brown` | `#3a2510` | 主文字 |
| `--ink-brown-d` | `#6a4a25` | 斜体/弱化 |

### 3.2 Typography

| 用途 | 字体 | 大小 | 备注 |
|---|---|---|---|
| chrome / chat / UI | **Manrope** (300/400/500/600/700) | 11–18 px | letter-spacing `0.01em–0.28em` 视层级 |
| 数字 / 时间 / state code | Manrope + `font-variant-numeric: tabular-nums` | inherit | 永远 tabular |
| HUD pill / eyebrow | Manrope 600 + `text-transform: uppercase` + `letter-spacing: 0.2em–0.3em` | 9–11 px | 装饰性大写 |
| 羊皮纸 markdown | **Cormorant Garamond** 400/500 + 偶尔 italic | 13–26 px | 仅 `.scroll-body` 内 |
| h2 (羊皮纸) | Cormorant + `font-variant: small-caps` | 17 px | 手稿感 |

中文/CJK fallback：Manrope 不含中文字形。需要中文时
`font-family: "Manrope", "PingFang SC", "Noto Sans CJK SC", sans-serif;`。
**不要**为了 BotW 风去找伪 hylian/elvish 字体——会变 cosplay。

### 3.3 Motion（**克制原则**：全站只有这三个）

| 动效 | 节奏 | 出现位置 |
|---|---|---|
| `pulse` 呼吸 | 2.4s ease-in-out infinite | `state-tag::before` 圆点、`seg.current::after` |
| `pulse-fast` 内核 | 2s ease-in-out infinite | 当前 state 六边形内核 |
| `blink` 光标 | 1.1s steps(2) infinite | composer 末端光标 |

新增动效前必须问自己：**它是 BotW 真有的（呼吸/脉冲/光标），还是我在加 AI 默认的"科技感"？**
如果是后者一律拒绝。**禁止**：粒子、扫描线、霓虹外发光阴影炫技、typewriter 打字效果、悬浮缩放抖动、blur 滤镜过渡。

### 3.4 几何 / 边角

- 边角 **2 px 硬边圆角或纯直角**（不要 8 px+ 圆角），状态 chip / 按钮一致。
- 边框默认 **1 px**，强调时 **2 px**，再粗就是错误。
- 头像、role 圆点是**唯一允许的圆形** (border-radius: 50%)。
- 六边形仅出现在 **state pipeline** 和 **背景 hex underlay**，不要泛滥到 chip / button。

### 3.5 间距 rhythm

无强制 grid。参考值：
- 面板 padding 14–24 px
- 消息纵向间距 18–22 px
- 内联 chip / pip gap 6–10 px
- 大区块之间用**渐变 hr**（`linear-gradient(90deg, transparent, var(--slate-edge), transparent)`），不要用实线

---

## 4. Layout & 层级

### 4.1 全局 shell

```
┌────────────────────────────────────────────────────────────────┐
│  titlebar  (固定 48px)                                          │
├──────────────┬─────────────────────────┬───────────────────────┤
│  tasks       │  chatroom               │  scroll (artifact)    │
│  240–360px   │  flex 1                 │  280–480px            │
│  drag-W      │  flex / no drag         │  drag-W / 可关闭      │
└──────────────┴─────────────────────────┴───────────────────────┘
```

**三栏的来源**：左 Slack/Discord 的导航栏 + 中聊天主区 + 右 Codex 的 inspector。
形状借鉴是有意的；视觉外观完全不像他们。

### 4.2 信息层级（必须在视觉上能区分）

```
workspace                 ← titlebar (品牌+元数据)
└── task (= chatroom)     ← 主单元；左栏一行一个
    ├── channels          ← 顶部 pills 一行（自由开 + 默认 main/handoff/topic）
    │   └── messages      ← 卡片流（agent / human / system 三种形态）
    │       └── artifacts ← 消息内 chip → 点击在右栏羊皮纸打开
    ├── seats             ← 底部 seats bar
    └── state (S0..S11)   ← chatroom header 下的六边形 pipeline
```

每多一层就**视觉降权一档**（字号、对比度、装饰）。channels 不要做出比 task 还重的视觉，artifacts 不要做出比 message 还重的视觉。

### 4.3 state 一律不藏

- state pill `[S6 · ACTIVE]` 在 chatroom title 右侧，**永远可见**。
- 六边形 12-seg pipeline 在 title 正下方，**永远可见**。
- chatroom profile（dashboard、factory 版本、seat 历史）藏在 title 左边 `▸ profile` 链接后面（点开滑出 sheet），**这里才需要点击**。

---

## 5. 组件库

> 命名遵循 [FSD](https://feature-sliced.design/) shared/entities/widgets/features 分层。
> 下方仅讲外观契约，不绑定到具体目录。

### 5.1 Avatar（怪物头像）

- 40 × 40 圆形，`border-radius: 50%`，深石板渐变底 + 2px role 色描边 + 外辉光圈 (`::before` 套圈 + box-shadow)。
- 内嵌 30 × 30 inline SVG 怪物剪影，`fill="currentColor"` 继承 role 色，自带 `filter: drop-shadow(0 0 3px currentColor)`。
- 怪物映射 + 实际 SVG 资产（**stand-in**：图标是 game-icons.net 上 CC BY 3.0 的通用奇幻图，**形似 Zelda 怪物**但非 Nintendo IP，可商用可改色）：

  | role | "怪物身份"（显示给用户） | 实际 SVG 资产 | 作者 | 文件 |
  |---|---|---|---|---|
  | planner | Wizzrobe | `wizard-face` | Delapouite | `docs/icons/planner.svg` |
  | engineer | Moblin | `orc-head` | Delapouite | `docs/icons/engineer.svg` |
  | qa | Octorok | `octopus` | Lorc | `docs/icons/qa.svg` |
  | anti | Lynel | `centaur` | Delapouite | `docs/icons/anti.svg` |
  | ci | Guardian | `all-seeing-eye` | Delapouite | `docs/icons/ci.svg` |
  | pm-ux | Korok | `tree-face` | Cathelineau | `docs/icons/pmux.svg` |
  | YOU | Link | `visored-helm` | Lorc | `docs/icons/you.svg` |

- **不要换怪**（识别度建立后乱换会失忆）；也**不要换图标资产**（即使找到"更像的"，CC BY 3.0 attribution 已经写死了一套）。
- SVG 全部在 `docs/icons/` 下，**单 path、viewBox=0 0 512 512、fill=currentColor**——拷到组件里改 className 就行，无需后处理。

### 5.2 State pipeline（六边形进度）

- 12 个六边形 segment，`clip-path: polygon(8% 0, 92% 0, 100% 50%, 92% 100%, 8% 100%, 0 50%)`。
- 三态：`passed`（暗 cyan）/ `current`（亮 cyan + 内核脉冲）/ 未到（slate-elev）。
- 下方一行 label：`S0 — S6 / S11  ·  14m in state`。
- 这是 **state machine 可视化的主载体**，永远出现在 chatroom header。不允许把它折叠/隐藏。

### 5.3 State tag pill

- chatroom title 右侧那颗 `[S6 · ACTIVE]`。
- 半透明 cyan 底 + 1px cyan-dim 边 + cyan-glow `box-shadow`（内外）+ `text-shadow` 让字也带光。
- 左侧带一颗呼吸圆点（`::before` + `pulse` 动画）。
- 失败/abort 时切到 `--malice` 红色调，否则一律 cyan。

### 5.4 Sysline（系统事件分隔线）

三种变体：

| 类型 | 颜色 | 用途 |
|---|---|---|
| `.sysline` | dim cyan/gray | state 转移、handoff、agent 加入/离开 |
| `.sysline.stamp` | `--link` 绿 + glow | **人类动作**（approve / pause / abort）|
| `.sysline.handoff` | dim | role → role 交接 |

左右各一条渐变 hr，文字居中，letter-spacing 拉开。
**铁律：人类动作必须用 stamp 变体**——你的每一次盖章都要在视觉上从消息流里浮出来。

### 5.5 Message 行

```
[avatar 40] [name(role色) · time]
            [body 13px ink-soft]
            [<chips/> | <progress/> | <you-quote/>]
```

- 不用聊天气泡（不要 Slack/iMessage 的圆角 bubble）。
- 人类发言用 `.you-quote` 左侧 2px Link 绿竖线 + glow。
- 不要给消息加底色背景——纯靠 avatar + name 色区分。

### 5.6 Artifact chip

- inline 矩形 + 左侧 6×10 cyan 六角形 marker。
- `selected` 态：cyan 边 + 文字 + glow（同 mockup）。
- 点击在右栏羊皮纸打开。
- **不要**做成 Slack 那种 "file preview card"——chip 永远紧贴消息，详情走右栏。

### 5.7 Channel tab

- 顶部一行 pills；选中态有 inset 底部 cyan 线 + 文字带 glow + 与下方 chatroom 同底色"咬合"。
- 末尾 `+` dashed 边的"开新 channel"按钮。
- 自由扩展，agent 自己开的 channel 用 `topic/xxx` 命名（如 `topic/auth`）。

### 5.8 Composer

- 黑底半透明 + 上方一条 cyan-dim glow 分隔。
- 左侧 `›` 提示符（cyan + glow）；末尾一根 8×16 cyan 闪烁光标。
- 右侧 `/approve /pause /abort /handoff` 提示，命令名用 cyan，`code` 字体仍是 Manrope（不切 mono，全站统一）。
- placeholder 用 italic + dim。

### 5.9 Task item（左栏 task 行）

- 12px 起手的 role-色发光圆点 + task 名 + state code。
- 圆点色 = **当前发言席位的 role 色**（带同色 glow）；idle 时回 dim 灰；done 时空心 cyan 描边 + ✓。
- 选中态：左侧 2px cyan 实线 + 右侧呼吸 4×14px cyan 光条。
- 不显示进度条/计数/缩略图——左栏是**导航**不是 dashboard。

### 5.10 Seats bar

- chatroom 底栏（在 composer 之上），列出全部 6 个席位 + 各自状态。
- 每个 seat = role-色圆点 + 名字。`.act` 文字白 + 圆点带 glow；`.blocked` 文字+圆点 malice 红。
- 顺序固定：planner → engineer → qa → pm-ux → anti → ci（按工作流时间顺序排）。

### 5.11 Scroll / Book panel（右栏）

- `--paper` 底 + radial gradient + SVG noise turbulence 营造手工纸感。
- 顶部 `.scroll-head` 棕色带 + 文件名 + ✕ 关闭。
- `.scroll-body` 内用 **Cormorant Garamond** 衬线 13–26px；h2 用 small-caps。
- 列表 `li::before` 是 ✦ 而不是默认的 disc。
- 底部 `.scroll-foot` 显示 `page N / M` + prev/next。
- 这是**唯一允许使用衬线字 + 暖色调**的地方，不要扩散到其他面板。

### 5.12 Titlebar

- 左：自绘 SVG Sheikah eye + brand 大写文字
- 右：meta（shift 日期 + 时间，tabular-nums）+ 两颗 `.icon-btn`（settings / quit）
- 高度 ~48px，下方 1px cyan-dim glow 分隔

---

## 6. 纪律（**不要做什么**）

### 6.1 视觉

- ❌ 不要满屏粒子 / 闪光 / blur 滤镜
- ❌ 不要给 button / chip 加 8px+ 圆角
- ❌ 不要把 role 色用在非 role 身份场景（如"通用强调色"）
- ❌ 不要扩散羊皮纸到右栏以外
- ❌ 不要扩散衬线字 (Cormorant) 到聊天/UI
- ❌ 不要做"AI 默认深色 + 单一酸绿"配色——cyan + 多 role 磷光是签名
- ❌ 不要加扫描线/CRT 弯曲滤镜
- ❌ 不要把任何 BotW 元素做成卡通水彩 fan-art（保持 UI 化、剪影化）

### 6.2 交互

- ❌ 不要把 state pill 折叠进 tooltip
- ❌ 不要把人类签收和普通消息视觉等同
- ❌ 不要在左栏 task 上加进度条/数字汇总（导航 ≠ dashboard）
- ❌ 不要给左栏 task 加多层嵌套树（最多 group label → list 两层）
- ❌ 不要给 abort/pause/destructive 动作做单击触发（必须二次确认或 hold-to-confirm，这条没写进 mockup 但实现时必加）

### 6.3 通用

- ❌ 不要替换 6 只怪物的映射（Wizzrobe→Moblin→Octorok→Lynel→Guardian→Korok+Link 已建立识别度）
- ❌ 不要把"YOU"换成头像名或邮箱——主角永远叫 YOU，永远是 Link 绿
- ❌ 不要在 dashboard 不知道怎么填的时候随便填占位指标，宁可留空字 `// dashboard · TBD`

---

## 7. 决策日志（**试过 → 放弃**，给后来者省路）

| 探索过的方向 | 为什么放弃 |
|---|---|
| 个人调度席 / fleet view（横向 state 车道铺所有 task） | 用户明确要"只关心每个任务各自的状态"，fleet 不需要 |
| Slack/Discord 风（圆头像 + 彩色 sidebar + 气泡） | 撞 AI SaaS 默认簇；agent 工作流不是 IM 对话，是结构化日志 |
| 黑客风（深色 + 多色磷光 + ASCII sigil 头像 + 单一 mono 字体） | 用户审美偏好换到 BotW；多色磷光的思路保留下来变成 role-color phosphor |
| Minecraft 风（像素 + 立体斜边 + Press Start 2P） | 视觉太 chunky、像素字阻碍信息密度，CJK 完全失效 |
| 角色用抽象 unicode rune（◊▲◉✶⌬）做头像 | 抽象到记不住；换成 BotW 怪物剪影后识别度立刻起来 |
| Mr. Robot 风 / 酸绿矩阵雨 / 扫描线 | 是 AI 默认簇 + 影响可读性 + 与单用户慢节奏不符 |
| 红色用于一般错误态 | 单用户本地慢节奏 + alarm fatigue。red 仅用于 anti role + abort/blocked 极少数 |

---

## 8. 未决事项（等用户拍板再实现）

1. **profile sheet 内部细节** —— dashboard 区当前是 `// TBD` 占位。等用户想清楚要呈现什么指标后再设计内容。
2. **空 chatroom ascii banner 是否保留** —— 之前在 Minecraft 版做过 ascii banner，BotW 版还没移植对应物。可能改为"Sheikah Slate 启动画面"。
3. **错误/abort/loading 三态视觉** —— 现在只有 normal + blocked 两种。abort 是否复用 `--malice`？loading（agent 启动中、artifact 解析中）用什么 motion？
4. **右栏 diff / image / table 视图** —— 目前只支持 markdown。三类内容如何在羊皮纸上呈现待设计。
5. **键盘快捷键体系** —— 一个长期生产力工具必须有；尚未设计。
6. **小屏 / 窄屏 fallback** —— 这是个 desktop 工具，但 ≤1200px 时怎么降级（折叠右栏？折叠左栏？）尚未定。
7. **CJK 字体 fallback 的精确栈** —— 上文给了候选，未实测渲染。
8. **dark mode 之外是否需要 light mode** —— 当前假设是 always dark（BotW Sheikah Slate 本身就是夜色）。如果要做 light 需重做几乎所有 token。

---

## 9. 实现起点建议

新接手做组件实现的人，建议这个顺序：

1. **先抽 token** —— 把 §3 的 CSS variables 写成 `apps/web/src/app/styles/tokens.css`（或对应 Tailwind config），全站都引这个。
2. **再做 shell** —— 三栏 + titlebar 跑起来，光秃秃也行，把 layout 和 resizable 调好。
3. **avatar + monster SVG** —— 从 mockup 文件里抽 6 + 1 个 SVG，做成 `<Avatar role="planner">` 单组件，先把人脸亮起来。
4. **message + sysline** —— 静态假数据，把消息流的三种形态（agent/human/system）跑通。
5. **state pipeline + tag** —— 这是签名元素，做好。
6. **左栏 task list 和右栏 scroll** —— 后做，因为它们高度依赖前面的 token 已稳定。
7. **接真数据 / WS / chatroom MCP** —— 最后接，前面任何抖动都不要往这里传染。

---

---

## 10. 资产归属 / Asset attribution

本项目 UI 用到的第三方资产，按 license 要求归属如下。**实现上线前必须保留这些 attribution**（最低要求：保留在 `docs/icons/` 同级一份 NOTICE 或在产品 about 页面提及）。

### 10.1 头像图标（CC BY 3.0）

来源：[game-icons.net](https://game-icons.net)，license [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/)。

| 文件 | 原始 slug | 作者 | 用作 | 直链 |
|---|---|---|---|---|
| `docs/icons/planner.svg` | `wizard-face` | Delapouite | Wizzrobe (planner) | [page](https://game-icons.net/1x1/delapouite/wizard-face.html) |
| `docs/icons/engineer.svg` | `orc-head` | Delapouite | Moblin (engineer) | [page](https://game-icons.net/1x1/delapouite/orc-head.html) |
| `docs/icons/qa.svg` | `octopus` | Lorc | Octorok (qa) | [page](https://game-icons.net/1x1/lorc/octopus.html) |
| `docs/icons/anti.svg` | `centaur` | Delapouite | Lynel (anti) | [page](https://game-icons.net/1x1/delapouite/centaur.html) |
| `docs/icons/ci.svg` | `all-seeing-eye` | Delapouite | Guardian (ci) | [page](https://game-icons.net/1x1/delapouite/all-seeing-eye.html) |
| `docs/icons/pmux.svg` | `tree-face` | Cathelineau | Korok (pm-ux) | [page](https://game-icons.net/1x1/cathelineau/tree-face.html) |
| `docs/icons/you.svg` | `visored-helm` | Lorc | Link (YOU) | [page](https://game-icons.net/1x1/lorc/visored-helm.html) |

**修改说明**：所有 SVG 已把 `fill="#fff"` 替换为 `fill="currentColor"`，未改路径数据。

### 10.2 字体

| 字体 | License | 用途 |
|---|---|---|
| [Manrope](https://fonts.google.com/specimen/Manrope) | OFL | chrome / chat / UI |
| [Cormorant Garamond](https://fonts.google.com/specimen/Cormorant+Garamond) | OFL | 右栏羊皮纸 markdown |

两者通过 Google Fonts CDN 加载，OFL 允许自由使用、嵌入、再分发，无 attribution 强制要求。

### 10.3 与 Nintendo IP 的关系

设计**用塞尔达术语命名 role 身份**（Wizzrobe / Moblin / Octorok / Lynel / Guardian / Korok / Link）以建立用户认知，但**不使用 Nintendo 任何原始图像、字体、商标**。所有视觉资产来自 CC BY 3.0 通用奇幻图标 + OFL 字体，可商用、可分发。"Zelda flavor" 只存在于命名约定和颜色情绪中。

---

**canonical 文件**：[`docs/design-mockup.html`](./design-mockup.html)
**本文档定位**：why + 规则，不是 what
**有冲突时**：mockup 赢

— end of handoff —
