/**
 * electron-mac-traffic-lights —— 把 macOS 系统红绿灯按钮组排进自定义侧栏。
 *
 * 背景：Electron `titleBarStyle: 'hidden'` 隐藏标题栏后，`trafficLightPosition`
 * 只能把**整组**系统按钮平移（含系统默认 11pt 间距），既改不了单颗钮间距、
 * 也挡不住系统在每次窗口 transition 后把按钮**重排回默认布局**（表现：自己
 * 改一次 frame，最大化/还原后按钮「弹跳」回去）。
 *
 * 本模块的治法（分层降级）：
 *   1. tighten()：FFI 调 AppKit 公开 API（standardWindowButton: + setFrameOrigin:）
 *      把三颗钮重排到自定义间距（默认 12pt 钮 + 6pt 间距，可调 positions 参数）；
 *   2. installRedrawHook()：swizzle Electron 的 WindowButtonsProxy.redraw
 *      （弹回的最终执行者，源码 shell/browser/ui/cocoa/window_buttons_proxy.mm），
 *      **原重排与自定义布局在同一次调用内完成**——渲染管线只看到最终位置，零跳动。
 *
 * ABI 红线（koffi 实测踩坑，违反即段错误崩主进程）：
 *   - 只允许 NSPoint（2×double = 16B，ARM64 走寄存器传参/返回）；
 *   - 禁止 NSRect（32B > 16B 走 x8 sret 间接返回）作为**函数返回类型**——
 *     koffi 声明大结构体返回类型会段错误。读位置用 frameOrigin（返回 NSPoint），
 *     写位置用 setFrameOrigin:（参数 NSPoint）；
 *   - koffi 回调注册第二参必须 koffi.pointer(Proto) 包裹；调裸 IMP 指针用
 *     koffi.call(ptr, Proto, args...)。
 *   参考：koffi.dev/callbacks、koffi.dev/pointers、
 *   mikeash「Dissecting objc_msgSend on ARM64」（结构体寄存器/sret ABI）。
 *
 * 兼容性：swizzle 点是 Electron 自有类的方法（objc_getClass 运行时可见），
 * 非 Apple 私有 API；但 Electron 升级若重命名 WindowButtonsProxy/redraw，
 * installRedrawHook 返回 false（降级：仅初始收紧生效，系统重排后会回弹）。
 * 用法上请检查返回值并打日志，方便升级时第一时间发现。
 */
'use strict';

const { BrowserWindow } = require('electron');

/** 默认布局：钮径 12pt、间距 6pt、左缘 6pt → x = 6 / 24 / 42（右缘 54） */
const DEFAULT_POSITIONS = [6, 24, 42];

let bridgePromise = null;
let syncedBridge = null;
let hookInstalled = false;

async function loadBridge() {
  const koffi = require('koffi');
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const sel = (name) => objc.func('sel_registerName', 'void *', ['str'])(name);
  const msgSend = objc.func('objc_msgSend', 'void *', ['void *', 'void *']);
  const msgSendLong = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'long']);
  const msgSendNSUInt = objc.func('objc_msgSend', 'unsigned long', ['void *', 'void *']);
  const object_getClassName = objc.func('object_getClassName', 'void *', ['void *']);
  const getClass = objc.func('objc_getClass', 'void *', ['str']);
  const class_getInstanceMethod = objc.func('class_getInstanceMethod', 'void *', ['void *', 'void *']);
  const method_getImplementation = objc.func('method_getImplementation', 'void *', ['void *']);
  const class_replaceMethod = objc.func('class_replaceMethod', 'void *', ['void *', 'void *', 'void *', 'str']);

  const selStandard = sel('standardWindowButton:');
  const selWindow = sel('window');
  const selContentView = sel('contentView');
  const selSubviews = sel('subviews');
  const selCount = sel('count');
  const selAtIndex = sel('objectAtIndex:');
  const selFrameOrigin = sel('frameOrigin');
  const selSetFrameOrigin = sel('setFrameOrigin:');

  // NSPoint 16B 寄存器 ABI——本模块唯一允许的结构体形态（见文件头红线）
  const NSPoint = koffi.struct('NSPoint', { x: 'double', y: 'double' });
  const msgSendGetPt = objc.func('objc_msgSend', NSPoint, ['void *', 'void *']);
  const msgSendSetPt = objc.func('objc_msgSend', 'void', ['void *', 'void *', NSPoint]);

  const classNameOf = (ptr) => {
    const namePtr = object_getClassName(ptr);
    return namePtr ? String(koffi.decode(namePtr, 0, 'char *')) : '';
  };

  // 兜底遍历：hidden 模式下 standardWindowButton: 可能返回 null，
  // 此时沿 contentView 深度优先找 NSButton，按 AppKit 按钮类名识别三钮。
  const collectButtons = (view, out = [], depth = 0) => {
    if (depth > 12 || !view) return out;
    const arr = msgSend(view, selSubviews);
    if (!arr) return out;
    const n = Number(msgSendNSUInt(arr, selCount));
    for (let i = 0; i < n; i++) collectButtons(msgSendLong(arr, selAtIndex, i), out, depth + 1);
    return out;
  };

  return {
    decodeHandle(buf) {
      // getNativeWindowHandle() 的 Buffer **内容**是 NSView* 指针值（非 Buffer 地址）
      const addr = koffi.decode(buf, 0, 'uintptr_t');
      return koffi.as(BigInt(addr), 'void *');
    },
    viewWindow(view) {
      return msgSend(view, selWindow);
    },
    windowButtons(nsWindow) {
      const close = msgSendLong(nsWindow, selStandard, 0);
      const mini = msgSendLong(nsWindow, selStandard, 1);
      const zoom = msgSendLong(nsWindow, selStandard, 2);
      if (close && mini && zoom) return { close, mini, zoom };
      const content = msgSend(nsWindow, selContentView);
      if (!content) return null;
      let c = null;
      let m = null;
      let z = null;
      for (const b of collectButtons(content)) {
        const n = classNameOf(b);
        if (n.includes('CloseButton')) c = b;
        else if (n.includes('MinimizeButton')) m = b;
        else if (n.includes('ZoomButton') || n.includes('FullScreenButton')) z = b;
      }
      return c && m && z ? { close: c, mini: m, zoom: z } : null;
    },
    frameOrigin(button) {
      return msgSendGetPt(button, selFrameOrigin);
    },
    setFrameOrigin(button, origin) {
      msgSendSetPt(button, selSetFrameOrigin, origin);
    },
    installRedrawHook(onRedraw) {
      try {
        const proxyClass = getClass('WindowButtonsProxy');
        if (!proxyClass) return false;
        const method = class_getInstanceMethod(proxyClass, sel('redraw'));
        if (!method) return false;
        const origImpPtr = method_getImplementation(method);
        if (!origImpPtr) return false;
        const ImpProto = koffi.proto('void ImpProto(void *self, void *_cmd)');
        const hookedImp = koffi.register((self, cmd) => {
          koffi.call(origImpPtr, ImpProto, self, cmd);
          // 关键：onRedraw 必须是同步路径。async 微任务晚于渲染 commit 一帧，
          // 用户会看到按钮先弹回再收紧的「一跳」。
          onRedraw();
        }, koffi.pointer(ImpProto));
        const replaced = class_replaceMethod(proxyClass, sel('redraw'), hookedImp, 'v@:');
        return Boolean(replaced);
      } catch {
        return false;
      }
    },
  };
}

/** 同步收紧核心：x 已在目标位则跳过写入（幂等，hook 高频调用零多余写） */
function tightenSync(b, win, positions) {
  try {
    const view = b.decodeHandle(win.getNativeWindowHandle());
    const nsWindow = b.viewWindow(view);
    if (!nsWindow) return false;
    const buttons = b.windowButtons(nsWindow);
    if (!buttons) return false;
    const order = [buttons.close, buttons.mini, buttons.zoom];
    for (let i = 0; i < 3; i++) {
      const origin = b.frameOrigin(order[i]);
      if (origin.x !== positions[i]) {
        b.setFrameOrigin(order[i], { x: positions[i], y: origin.y }); // 只改 x，y 保持系统值
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 收紧一次窗口的三颗系统按钮到自定义间距。
 * @param {BrowserWindow} win
 * @param {[number, number, number]} [positions] 三颗钮 x（默认 6/24/42）
 * @returns {Promise<boolean>} 非 darwin 平台返回 true（无需收紧）
 */
async function tighten(win, positions = DEFAULT_POSITIONS) {
  if (process.platform !== 'darwin') return true;
  if (syncedBridge) return tightenSync(syncedBridge, win, positions);
  try {
    if (!bridgePromise) bridgePromise = loadBridge();
    syncedBridge = await bridgePromise;
    return tightenSync(syncedBridge, win, positions);
  } catch (err) {
    console.warn('[traffic-lights] 收紧失败，保持系统默认布局：', err.message);
    return false;
  }
}

/**
 * 一站式安装：立即收紧 + swizzle redraw 自愈（进程级一次）。
 * 在窗口 show 之后调用（系统装配交通灯后按钮才取得到）。
 * @param {BrowserWindow} win
 * @param {[number, number, number]} [positions]
 * @returns {Promise<{tightened: boolean, hook: boolean}>}
 */
async function setup(win, positions = DEFAULT_POSITIONS) {
  const tightened = await tighten(win, positions);
  let hook = false;
  if (tightened && syncedBridge && !hookInstalled) {
    hookInstalled = syncedBridge.installRedrawHook(() => {
      // 同步路径：redraw 的同一次调用内完成收紧（见 loadBridge 注释）
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) tightenSync(syncedBridge, w, positions);
      }
    });
    if (!hookInstalled) {
      console.warn('[traffic-lights] redraw hook 未装成：窗口操作后间距会回弹为系统默认');
    }
  }
  return { tightened, hook: hookInstalled };
}

module.exports = { tighten, setup, DEFAULT_POSITIONS };
