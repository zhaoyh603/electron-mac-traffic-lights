# electron-mac-traffic-lights

把 macOS **系统原生**红绿灯按钮组排进自定义窄侧栏——单颗间距可调、最大化/还原/全屏/resize **零弹跳**、绿钮 hover 的系统平铺面板完整保留。

```
┌──┬──────────────────────────────┐
│◉◉◉│            60px 侧栏窗口      │  ← 系统三钮收紧为 12pt 钮 + 6pt 间距
├──┤                              │     （默认 x = 6 / 24 / 42，可自定义）
│  │                              │
└──┴──────────────────────────────┘
```

## 为什么需要它

Electron 隐藏标题栏（`titleBarStyle: 'hidden'`）后：

- `trafficLightPosition` 只能**整组**平移，改不了单颗钮间距（系统默认 11pt，组宽超出窄栏）；
- 你手动改按钮 frame，系统在每次窗口 transition（最大化/还原/全屏/resize）后会把按钮**重排回默认布局**——用户看到的就是「弹一下」。

社区教程普遍停在 `hiddenInset` + 整组定位。要「系统原生按钮 + 自定义间距 + 不弹跳」三者兼得，就是本仓做的事。

## 治法（两层）

1. **收紧**：koffi（FFI）调 AppKit **公开** API——`standardWindowButton:` 定位三颗钮、`setFrameOrigin:` 只改 x（y 保持系统值）；
2. **防弹跳（治本）**：弹回的最终执行者是 Electron 的 `WindowButtonsProxy.redraw`（`shell/browser/ui/cocoa/window_buttons_proxy.mm`，每次 transition 后重排按钮）。用 `class_replaceMethod` swizzle 它：**原重排与收紧在同一次调用内完成**，渲染管线只看到最终位置——不是事件钩子（晚一拍）、不是轮询自愈（会跳），是注入到布局流程本身。

## 快速开始

```bash
pnpm install
pnpm start
```

窗口起来后验证：点绿钮最大化/还原、进出全屏、拖拽改大小——按钮全程钉在紧凑位；hover 绿钮约 1 秒，系统平铺面板（Move & Resize）照常弹出。

## 用法

```js
const { setup } = require('./lib/traffic-lights');

win.once('ready-to-show', () => {
  win.show();
  setup(win);                    // 默认 6/24/42
  // setup(win, [4, 21, 38]);    // 自定义：左缘 4、间距 5
});
```

⚠️ 必须在窗口 `show` **之后**调用——系统装配交通灯前 `standardWindowButton:` 拿到的是 null。

## koffi FFI 三条红线（违反 = 段错误崩主进程）

| 红线 | 原因 |
|---|---|
| 只用 **NSPoint**（2×double，16B） | ARM64 走寄存器传参/返回，koffi 兼容 |
| 禁止 **NSRect**（32B）作**返回类型** | >16B 结构体走 x8 sret 间接返回，koffi 声明即段错误。读位置用 `frameOrigin`（返 NSPoint），不要用 `frame`（返 NSRect） |
| 回调内必须**纯同步** | async 微任务晚于渲染 commit 一帧 = 用户看到一跳 |

回调注册：`koffi.register(fn, koffi.pointer(Proto))`；调裸 IMP：`koffi.call(ptr, Proto, args...)`。

## 兼容性与降级

- swizzle 点是 Electron **自有类**的方法（`objc_getClass('WindowButtonsProxy')` 运行时可见），不是 Apple 私有 API；
- Electron 升级若重命名该类/方法，`setup()` 返回 `{ hook: false }`（检查它并打日志）——降级后初始收紧仍生效，但窗口操作后会回弹系统默认布局；
- 非 darwin 平台 `setup()` 直接返回成功（无操作）。

在 Electron 39.8.10 / macOS Sequoia (ARM64) 上验证。

## License

MIT
