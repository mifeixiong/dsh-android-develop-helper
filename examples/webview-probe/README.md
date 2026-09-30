# WebView 探针

一个 12 KB 的 App，用来回答一个问题：**`uiautomator` 到底能不能看到 `WebView` 里面的东西？**

它不做别的：上面一对原生控件作对照组（有真正的 `android:id`），下面一个 `WebView` 渲染一段
DOM——标题、段落、带 `id` 和 `aria-label` 的按钮、输入框、一个被点击后才改的结果文本。

```powershell
node tools/build-apk.mjs --project examples/webview-probe --out examples/webview-probe/wvprobe.apk
node bin/android-helper.mjs install examples/webview-probe/wvprobe.apk
node bin/android-helper.mjs start com.example.wvprobe
node bin/android-helper.mjs ui --max 40
```

## 结论（实测）

**DOM 是可见的，HTML 的 `id` 就是 `resource-id`。**

```
#0 Text "原生 TextView（对照组）" id=tvNative @360,41
#1 Button "原生按钮（对照组）" id=btnNative @136,95 [tap]
#3 Text "网页标题" id=wv-heading @360,203
#4 Text "这段文字来自 DOM，不是原生 View。" id=wv-paragraph @360,269
#5 Button "网页按钮" id=wv-button @100,330 [tap,focused]
#6 Input id=wv-input hint="网页输入框" @192,389 [tap]
#7 Text "结果：按钮被点到了" id=wv-out @360,448
```

`wv-heading` / `wv-button` / `wv-input` 这些都不是 Android 资源 id，而是 HTML 的 `id` 属性——
WebView 通过无障碍树把它们报成了 `resource-id`。`tap-id wv-button` 直接命中（`-> 100,330`），
点击后网页里的 `结果：按钮被点到了` 也读得到。**不需要 CDP，也不需要坐标退路。**

## 但有一个坑：这棵树是惰性建立的

App 刚启动时第一次 dump，WebView 只报一个空节点：

```
# 6 节点 → 4 条
#2 WebView id=webView @360,693 [tap]
```

再 dump 一次（同一台设备、同一个页面、同样的命令），内部节点全部出现，节点数从 6 变成 13。
WebView 要等到有活跃的无障碍客户端持续请求，才开始构建并暴露它的虚拟节点树；
`uiautomator` 的第一次连接常常只是"把客户端叫醒"。

**所以：第一次 `ui` 看不到网页内容时，不要下结论，再执行一次。** 这与"内容真的不在树里"
是两回事，而这个探针就是为了把两者分开。

## CDP 仍然有它的位置

`WebView.setWebContentsDebuggingEnabled(true)`（本探针已开）会在设备上开一个 devtools
socket，转发出来就是一个 CDP 端点：

```powershell
adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
curl http://127.0.0.1:9222/json          # 列出页面，含 webSocketDebuggerUrl
```

连上 WebSocket 发 `Runtime.evaluate`，这个页面的回答是：

```json
{"totalDomNodes":11,"headingText":"网页标题","outText":"结果：按钮被点到了","url":"https://probe.example/"}
```

对比一下：DOM 有 11 个元素，无障碍树里只有 6 个——`html`、`head`、`meta`、`body`、`script`
以及纯布局用的 `div` 不会出现，因为它们在无障碍语义上没有角色。CDP 还能给你：

- **执行 JS**：读应用状态、直接调函数、绕过 UI 驱动页面
- **`canvas` / Shadow DOM / 跨域 iframe 内部**：无障碍树里拿不到
- **网络与控制台**：`Network.*` 与 `Log.*` 域
- **精确布局**：CSS 盒模型，而不是无障碍 bounds 的近似值

这套工具读的是无障碍树那一侧——对"驱动 App"够用，对"看穿页面"不够。这是能力边界，
不是遗漏；README 的「已知限制」里如实写着。

## 结构

```
examples/webview-probe/
├── AndroidManifest.xml
├── java/com/example/wvprobe/MainActivity.java   # WebView + 对照组，HTML 内联在常量里
└── res/layout/activity_main.xml                 # tvNative / btnNative / webView
```

构建走免 Gradle 那条链路（`tools/build-apk.mjs`，约 4 秒），所以这个探针在任何装了
Android SDK 的机器上都能重建，不需要 Flutter 或 Gradle。
