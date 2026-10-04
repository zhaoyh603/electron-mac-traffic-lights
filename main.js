'use strict';
/**
 * demo 入口：一个 60px 窄侧栏窗口，验证系统红绿灯三钮收紧 + 零弹跳。
 * 运行：npm start（窗口起来后试试最大化/还原、全屏、拖拽——按钮应全程钉住）。
 */
const { app, BrowserWindow } = require('electron');
const { setup } = require('./lib/traffic-lights');

const HTML =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(
    `<body style="margin:0;font:14px -apple-system,sans-serif;background:#1e1e2e;color:#cdd6f4">
       <div style="width:60px;height:100vh;background:#181825;border-right:1px solid #313244;
                   -webkit-app-region:drag"></div>
       <div style="position:absolute;left:80px;top:24px;max-width:520px;line-height:1.8">
         <h2>electron-mac-traffic-lights demo</h2>
         <p>左侧是 60px 窄栏（可拖拽）。三颗<b>系统原生</b>红绿灯经 FFI 收紧为
         12pt 钮 + 6pt 间距（x = 6/24/42）。</p>
         <p>验证零弹跳：点绿钮最大化/还原、进出全屏、拖拽改窗口大小——
         按钮应全程钉在紧凑位；hover 绿钮的窗口平铺面板仍是系统原生。</p>
       </div>
     </body>`,
  );

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 860,
    height: 560,
    titleBarStyle: 'hidden',
    // 底座：整组贴左。间距由 lib/traffic-lights.js 收紧（trafficLightPosition 改不了单颗间距）
    trafficLightPosition: { x: 0, y: 8 },
    show: false,
  });
  win.loadURL(HTML);
  win.once('ready-to-show', () => {
    win.show();
    // 窗口 shown 之后系统才装配交通灯——这时才能取到按钮（提前调拿到的都是 null）
    setup(win).then(({ tightened, hook }) => {
      console.log(`[demo] 初始收紧: ${tightened ? 'OK' : '失败'} / redraw hook: ${hook ? 'OK' : '未装成'}`);
    });
  });
});
