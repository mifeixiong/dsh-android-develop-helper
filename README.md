# dsh-android-develop-helper

[![CI](https://github.com/mifeixiong/dsh-android-develop-helper/actions/workflows/ci.yml/badge.svg)](https://github.com/mifeixiong/dsh-android-develop-helper/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> 原名 `dsh-mumu`。核心能力不变——**通过 ADB 驱动 Android 模拟器，辅助 AI Agent 快速开发、调试、测试与定位安卓应用错误**；
> 适用范围从「仅 MuMu 模拟器 + 应用开发」扩展为「多模拟器兼容 + 开发全流程辅助」。

零依赖、零构建步骤。Node.js 20+ 即可运行。

---

## 1. 它是什么

一个 AI Agent 可以调用的 Android 模拟器操作层。三条入口，同一套实现：

| 入口 | 形态 | 用途 |
| --- | --- | --- |
| **原生工具** | `android_devices` / `android_doctor` / `android_screenshot` / `android_ui` / `android_tap` / `android_input` / `android_wait` / `android_app` / `android_logcat` | DSH Agent 直接调用，无需 shell |
| **技能** | `SKILL.md`（随仓库分发）/ `~/.dsh/skills/dsh-android-develop-helper/SKILL.md` | 让任何 DSH Agent 发现并使用这套能力 |
| **CLI** | `node bin/android-helper.mjs <命令>` | 人在终端里排查，或任何支持子进程的 Agent |

### 作为 dsh 插件安装

`package.json` 声明了 `dsh.bundle.patch: ./cordis.patch.yml`，安装包即可挂载，不需要手写路径：

```powershell
dsh plugin install dsh-android-develop-helper
```

`cordis.patch.yml` 插入一行 `name: 'dsh-android-develop-helper/plugin'` 的行组合项，
`apply()` 把九个工具注册进 harness 的 `tools` 注册表。`flags` 默认留空——
`emulatorType` 不写就会按机器上装了哪个厂商的启动器自动判定，所以同一份补丁在
MuMu / 雷电 / 夜神 / AVD 的机器上都能直接用。

### 从源码挂载（开发时）

`src/plugin.js` **不 import 任何 harness 包**（只有相对路径与 `node:` 内置模块），
所以可以直接用绝对 URL 挂载，不必装进 profile 的 `node_modules`：

```yaml
# $DSH_HOME/cordis.patch.yml
- insert:
    - id: android-develop-helper
      name: 'file:///E:/code/dsh-Android-develop-helper/src/plugin.js'
      config:
        timeoutMs: 300000
        flags:
          emulatorType: mumu
          adbPort: 16384
```

这也是它**不声明任何 harness peer 依赖**的原因：没有需要解析的裸模块说明符，
就不会在 harness 版本升级时被判成 `incompatible-version` 而整个 bundle 失效。

组合项在加载时被 import 一次，因此**改动插件源码要等下一次 dsh 启动才生效**，不是热更新。
CLI 和测试不受影响，它们每次都是新进程。

两条路径**不要同时用**：同一个插件挂两次会让九个工具注册两遍。

运行产物（截图、UI dump、adb 日志）默认写到 `<包目录>/artifacts/`；
作为 bundle 安装时包在 `node_modules` 里，所以插件会把根目录切到会话工作目录
（`<cwd>/artifacts/`）。显式设置 `artifactsDir`（配置项或 `ANDROID_HELPER_ARTIFACTS`）永远优先。

---

## 2. 多模拟器兼容：为什么需要指纹去重

这一层存在的唯一理由，是模拟器的**设备身份不稳定**：

- 同一台 MuMu 12 实例会**同时**在 `127.0.0.1:16384`、`127.0.0.1:7555`、`emulator-5554` 上应答；
- 但每台 MuMu 的 `ro.product.model` **完全相同**，`adb devices -l` 分不出谁是谁；
- AVD 用 `-ports 5554,9999` 启动时，serial `emulator-5554` 与真实 ADB 端口 9999 毫无关系；
- MuMu 12 的端口不固定，要用户在模拟器「右上角菜单 → 问题诊断」里看。

按 serial 字符串选设备，必然导致 `more than one device/emulator`，或者**静默操作错误的实例**。

本项目的做法：

1. 收集所有可达传输通道（`adb devices` + 厂商 CLI 查询 + TCP 探测厂商端口段）；
2. **先问厂商**：MuMu 用 `MuMuManager info -v all`、雷电用 `ldconsole list2`，
   直接拿到每个实例的**准确 ADB 端口**。目标文档说「MuMu 12 的 ADB 端口需要从模拟器
   右上角菜单 → 问题诊断里看」——这一步现在由程序完成，不需要人去看：
   ```
   $ node bin/android-helper.mjs instances
   模拟器类型: mumu
   [0] MuMu安卓设备  adb=127.0.0.1:16384  android=15.0  运行中
   ```
   厂商没提供端口的那部分才回退到探测；
3. 跳过 `offline` / `unauthorized`；
4. 用**跨线读取的指纹**（`android_id` + `ro.build.fingerprint` + model）给 serial 分组；
5. 每组折叠成一个规范 serial（优先上次解析结果 → 显式配置 → `emulator-*` → 端口号最小）；
6. 只有存在**多个不同实例**时才要求 `--device`。

`emulatorType` 留空（默认 `custom`）时，会按「机器上装了哪个厂商的启动器」自动判定，
所以换一台只装了雷电的机器不需要改配置。显式配置的值永远优先。

实测（本机 MuMu 12）：

```
$ node bin/android-helper.mjs doctor
设备      : 127.0.0.1:16384
✓ 设备属性           Xiaomi 2206123SC / Android 15 (SDK 35)
✓ 截图             720x1280 → 360x640, 73 KB (原 3600 KB)
✓ UI 树           87 节点 → 精简为 85 条 (来源 uiautomator:tty)
! 同一实例被 4 个 serial 暴露 (127.0.0.1:16384, 127.0.0.1:5555, 127.0.0.1:7555, emulator-5554)，已固定使用 127.0.0.1:16384
```

### 配置项

`config.json` / CLI 参数 / `ANDROID_HELPER_*` 环境变量，全部有可用默认值。

| 配置项 | 说明 | 示例 |
| --- | --- | --- |
| `adbPath` | adb 路径；自动从 `ANDROID_HOME`、厂商安装目录、`PATH` 逐级查找 | `D:\...\adb_41\adb.exe` |
| `emulatorType` | `mumu` / `ldplayer` / `nox` / `avd` / `genymotion` / `custom`；留空则自动检测 | `mumu` |
| `adbPort` | 直接 `adb connect 127.0.0.1:<adbPort>` | `16384` |
| `consolePort` | console 端口；ADB 端口按 `console + 1` 推断 | `5554` |
| `deviceSerial` | 直接指定 serial，优先级最高，跳过全部推断 | `emulator-5554` |
| `autoDiscover` | 是否自动发现（默认 `true`） | `true` |
| `ports` | 额外候选端口 | `[16384, 7555]` |

**端口解析优先级**：`deviceSerial` → `adbPort` → 自动发现（厂商 CLI 精确端口优先，再端口探测）
→ 多设备时拒绝并列出候选。

```powershell
node bin/android-helper.mjs config --set adbPort=16384
node bin/android-helper.mjs config --set emulatorType=mumu
```

启动模拟器本体（`adb connect` 只能连已经在跑的实例）：

```powershell
node bin/android-helper.mjs start-emulator [--wait] [--timeout MS] [--launcher PATH]
```

它会按厂商找到启动器（MuMu → `MuMuManager control --vmindex 0 launch`，雷电 → `dnplayer.exe`，
AVD → `emulator.exe`），并且**在已有实例监听时直接返回**，不会重复启动第二个实例。

---

## 3. 能力

### 3.1 看屏幕

```powershell
node bin/android-helper.mjs shot --scale 0.4            # 读原始 framebuffer → 裁剪 → 缩放 → PNG
node bin/android-helper.mjs shot --region 0,0,720,400
node bin/android-helper.mjs ui --max 60                 # 带索引的可交互元素列表
node bin/android-helper.mjs ui --labels-only --refresh
```

**截图压缩是自己实现的**：`screencap` 的原始 framebuffer 头部（12 或 16 字节，按长度自动判定）
解析出 RGBA，再做裁剪、box/nearest 缩放，最后用 `zlib` 自己编码 PNG（过滤器 Sub、丢弃 alpha）。
不依赖任何图像库，也不需要设备端二次编码。720x1280 从 3.5 MB 原始数据降到几十 KB。

```
$ node bin/android-helper.mjs shot --scale 0.35
720x1280 → 252x448 (3600KB → 46KB, 78.8x) hash=fff8ffff...
```

**UI 树精简**：`uiautomator` 单次约 2 秒（瓶颈是 instrumentation 启动，不是树的大小），
原始 XML 约 34 KB。精简输出只保留可操作/有文本的节点，并给每个节点一个**小整数索引**，
模型可以直接 `tap-node 6` 回传：

```
#5 Image id=scheduleAdd @504,93 [tap]
#6 Image id=scheduleImport @564,93 [tap]
```

`uiautomator dump` 在部分模拟器镜像上写完后会 SIGSEGV，因此退出码被刻意忽略，
以 payload 是否完整为准；先试单次往返的 `/dev/tty`，失败再退回文件方式。

### 3.2 操作屏幕

```powershell
node bin/android-helper.mjs tap-text "从教务导入"      # 自动等待 + 自动上溯到最近的可点击祖先
node bin/android-helper.mjs tap-id scheduleImport
node bin/android-helper.mjs tap-node 6
node bin/android-helper.mjs tap-and-wait 课表 --exact   # 点击 + 等待稳定 + 新 UI 树 + 截图，一次往返
node bin/android-helper.mjs scroll down --times 3
node bin/android-helper.mjs text "408" --replace
node bin/android-helper.mjs key back
```

`tap-and-wait` 把「点击 → sleep → dump → 截图」压成一次调用，这是在没有设备端 Agent 的前提下
最大的延迟优化点。

**非 ASCII 输入**需要 ADBKeyboard IME（`com.android.adbkeyboard`）。没装时只输入 ASCII 部分，
并返回 warning——而不是静默写入一个不同的字符串。

### 3.3 等待，而不是 sleep

```powershell
node bin/android-helper.mjs wait-text "个人课表查询" --timeout 30000
node bin/android-helper.mjs wait-id bottom_sheet_create_schedule_btn
node bin/android-helper.mjs wait-activity "ScheduleActivity"
node bin/android-helper.mjs wait-idle
```

`wait-idle` 用**帧感知哈希**（8x8 平均哈希 + 平均亮度后缀）判断画面是否稳定。
纯平均哈希对亮度不敏感——纯黑和纯白会哈希成同一个值——所以加了亮度后缀，
否则淡入淡出这类「结构不变、亮度变化」的过渡会被误判为已稳定。

超时时抛出的错误包含当前 Activity、可见元素列表和截图路径，让失败可诊断，而不只是慢。

### 3.4 应用

```powershell
node bin/android-helper.mjs apk-info build\app.apk   # 包名/版本/SDK，不需要 aapt
node bin/android-helper.mjs install build\app.apk    # 安装 + 校验
node bin/android-helper.mjs start com.example.app    # 自己解析 launcher Activity
node bin/android-helper.mjs stop com.example.app
node bin/android-helper.mjs grant com.example.app    # 补授运行时权限
node bin/android-helper.mjs pkg com.example.app
```

`install` **不相信 `Success`**。这句话有两层意思：

其一，装完要验哈希——解析 `pm path`、在设备端算 SHA256、与本地文件比对，不一致直接失败并打印两个哈希。
跨线的只有 64 个字符，所以 36 MB 的 APK 校验耗时不到 1 秒。

其二，**`Success` 本身就可能出现在一次失败的安装里**。Android 13+ 的流式安装会这样输出：

```
Performing Incremental Install
Performing Streamed Install
Success: streamed 37341 bytes
Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: … signatures do not match …]
```

退出码是 **0**。`Success:` 描述的是字节流，不是包提交。任何 `/Success/ && exit === 0`
的判断都会把"什么都没装"当成成功——这是开发这个工具时真实踩到的坑，
现在 `classifyInstallOutput()` 以 `Failure [CODE]` 为准，并把常见错误码翻译成下一步动作。

```
$ node bin/android-helper.mjs install build\app.apk
安装失败 [INSTALL_FAILED_UPDATE_INCOMPATIBLE]: 设备上已安装的包与新 APK 签名不一致
（通常是用不同密钥重新构建过）。先 uninstall 再安装，或固定使用同一个签名密钥。
```

包名来自**真正解析二进制 `AndroidManifest.xml`**（AXML），而不是字节模式匹配。
后者会把 `androidx.lifecycle_lifecycle` 这类库名当成包名，从而让后续校验静默失效——
这也是真实踩到的坑，已修复并加了回归测试。

`launch` 只用包名时，先走 `cmd package resolve-activity --brief`，再退回 `monkey`。

`grant` 会从 `dumpsys package` 里读出所有 `granted=false` 的运行时权限并逐个 `pm grant`。
它解决的是一个很隐蔽的问题：`pm clear` **会撤销** `install -g` 授予的权限，
于是 App 能启动，但通知静默失败。

### 3.5 定位错误

```powershell
node bin/android-helper.mjs logcat --package com.example.app --grep "Exception|FATAL" --max 200
node bin/android-helper.mjs diagnose com.example.app   # 解析堆栈 + 定位到源码行 + 截图
node bin/android-helper.mjs activity                  # 前台到底是什么
```

`diagnose` 不只是 `grep FATAL`。它把日志解析成三类**各自按本来形态**处理的证据：

| 证据 | 解析方式 |
| --- | --- |
| `crashes` | `FATAL EXCEPTION` 块 → 异常类型/消息/线程/进程/调用栈/`Caused by` 链 |
| `tombstones` | native 崩溃块 → 信号、fault addr、backtrace（按日志 tag 划块，不按单行匹配） |
| `findings` | 没有堆栈可解析的形态：ANR、StrictMode、OOM、进程死亡 |

最有用的字段是 `location`——**第一条属于应用自己的栈帧**（跳过 `android.view.View.performClick`
这类框架帧，以及 `-$$Nest$m…` 这类脱糖合成帧），也就是该去打开的那一行：

```
$ node bin/android-helper.mjs diagnose com.example.dormduty
包      : com.example.dormduty
进程    : pid 44272 → (已退出)  ← 进程已死亡
当前前台: app.lawnchair/app.lawnchair.Launcher
结论    : 发现崩溃  （已忽略 1 条属于其他进程的崩溃记录）

崩溃: java.lang.ArithmeticException: divide by zero
  线程: main
  进程: com.example.dormduty (pid 44272)
  定位: MainActivity.java:197  ← com.example.dormduty.MainActivity.splitBill
  调用栈:
    at com.example.dormduty.MainActivity.splitBill(MainActivity.java:197)
    at com.example.dormduty.MainActivity.-$$Nest$msplitBill(Native Method)
    at com.example.dormduty.MainActivity$7.onClick(MainActivity.java:126)
    at android.view.View.performClick(View.java:8081)
    …

截图: artifacts\…\0-diagnose.png
```

三个决定成败的细节：

- **进程是否真的死了**。`diagnose` 前后各读一次 pid；崩溃会杀掉进程，所以 `pid → (已退出)`
  是独立于日志的第二份证据，也把「应用崩了」和「应用只是打了条错误日志」区分开。
- **别把别的进程算到应用头上**。`crash` buffer 是**全设备共享**的，而 `uiautomator` 在这台机器上
  每次 dump 都会 SIGSEGV。按包名过滤后，属于其他进程的记录进 `ignored` 而不是 `findings`——
  被真正丢弃和静默忽略，这两者不一样。
- **合成帧不能截断堆栈**。R8/脱糖会产生 `MainActivity.-$$Nest$msplitBill` 这种带 `-` 的方法名；
  栈帧正则不接受 `-` 的话，堆栈会在第一帧合成帧处断掉，把真正的调用者全部藏起来。

截图解决的是另一半问题：日志说「崩在哪」，截图说「崩之前用户看到什么」。两者一起才是现场。

### 3.6 完整命令表

见 `node bin/android-helper.mjs help`。所有命令都支持 `--json`，以及
`--device` / `--adb` / `--emulator` / `--adb-port` / `--console-port` / `--timeout` / `--echo` / `--no-probe`。

两个逃生口：

- `shell "<设备端命令>"` — 直接用当前固定设备执行 `adb shell`。读 App 私有状态
  （`run-as <pkg> cat shared_prefs/…`）、查 `dumpsys`、改系统设置都靠它。
- `rotate [portrait|landscape|0-3]` — 查看或固定屏幕方向。模拟器横屏时 `wm size`
  仍然报告竖屏尺寸，插件会按旋转角交换宽高，否则 `scroll` 会在错误的框里裁剪手势。

所有 adb 命令、完整 stdout/stderr、耗时都**不截断**地写入
`artifacts/<时间戳>-<标签>/log.txt`。工具调用与 CLI 每次都会新建一个目录，
不会把后续所有截图都塞进第一次连接的那个目录里。

---

## 4. 目录结构

```
dsh-android-develop-helper/
├── bin/android-helper.mjs     # CLI 入口
├── src/
│   ├── cli.js                 # 命令派发 + 参数解析 + --json 输出
│   ├── config.js              # 多模拟器配置、端口推断、adb 自动定位
│   ├── adb.js                 # adb 传输层：spawn、超时、树杀、错误归因
│   ├── devices.js             # 设备发现、TCP 探测、指纹去重、规范 serial
│   ├── device.js              # Device 门面：缓存、等待、复合操作
│   ├── manager.js             # AndroidSession：连接复用 + 传输失败重解析
│   ├── screen.js              # 原始 framebuffer 解码 / 裁剪 / 缩放 / PNG 编码 / 感知哈希
│   ├── crc32.js               # PNG 与 ZIP 共用的 CRC-32
│   ├── zip.js                 # ZIP 中央目录读取 + 4 字节对齐的写入器
│   ├── xml.js                 # 极简容错 XML 解析
│   ├── uitree.js              # UI 树解析、查询、精简、索引
│   ├── input.js               # tap / swipe / scroll / text / key（含双层 shell 转义）
│   ├── app.js                 # 安装（含校验与输出判定）/ 启动 / 停止 / 包信息 / 授权
│   ├── apk.js                 # ZIP 定位 + AXML 解析（免 aapt）
│   ├── logcat.js              # 过滤 + 崩溃解析（FATAL EXCEPTION / tombstone / ANR）+ 源码行定位
│   ├── tools.js               # 九个 {name, description, parameters, output, execute}
│   ├── plugin.js              # Cordis Host 插件：注册到 tools 注册表
│   └── index.js               # 公共 API
├── tools/
│   ├── install-sdk.mjs        # 从 Google 清单直接拉取最小 SDK（约 126 MB，免 sdkmanager）
│   ├── build-apk.mjs          # 免 Gradle 构建：aapt2 → javac → d8 → 自研打包 → apksigner
│   ├── sdk-urls.mjs           # 解析当前 SDK 包下载地址
│   └── probe-device.mjs       # 逐项排查单个 serial
├── examples/dorm-duty/        # 示例 App：Java + 传统 View，控件全部带显式 android:id
├── cordis.patch.yml           # bundle 补丁层：插入插件行（由 package.json 声明）
├── SKILL.md                   # 文件系统技能，随仓库一起分发
├── .github/workflows/ci.yml   # 单元测试 + bundle 清单自检
├── test/                      # 131 个单元测试 + 14 个真机测试
├── artifacts/                 # 每次运行的日志、截图、UI dump（不入库）
└── config.json                # 可选覆盖（默认不存在，不入库）
```

关键设计都写在对应源文件的文件头注释里，说明**为什么**这么做，而不只是做了什么。

---

## 5. 验证

单元测试与设备无关，CI（`.github/workflows/ci.yml`）在 ubuntu 与 windows 两个 runner 上跑它们
（Node 20 / 22），并额外做一次 bundle 清单自检：`dsh.bundle.patch` 指向的文件必须存在，
`./plugin` 与 `./cordis.patch.yml` 导出必须齐全。补丁文件缺失或入口写错时，安装会「成功」
但一个工具都不注册，这两项检查就是拦它的。

```powershell
npm test          # 131 个单元测试，不需要模拟器
npm run test:live # 9 个集成测试，对着真实模拟器跑；没有设备时自动 skip
npm run test:e2e  # 2 个端到端测试：完整跑一遍验证 App
npm run test:crash # 3 个测试：制造异常 → Logcat 解析 → 定位到源码行
```

单元测试覆盖：XML/AXML 解析、UI 树查询与精简、原始 framebuffer 解码（12/16 字节头）、
裁剪缩放、PNG 编码（含 zlib 回读校验）、感知哈希的分辨率无关性与亮度敏感性、
ZIP 中央目录读取与 4 字节对齐写入、CRC-32 标准校验值、安装输出判定、
logcat 前缀解析、`FATAL EXCEPTION` 与 `Caused by` 链解析、tombstone 分块、
崩溃归因与跨进程过滤、参数转义、按键解析、端口推断、设备指纹、屏幕旋转换算、
CLI 参数解析、工具定义（含用 harness 真实的 `assertSupportedJsonSchema` 校验每个 schema）。

集成测试断言的是**设备上观察到的状态**，不是工具自己的说法：

| 测试 | 断言 |
| --- | --- |
| doctor | 所有自检项通过 |
| 截图缩放 | 0.5x 的字节数真的小于 1x，且两者来自同一 framebuffer |
| UI 树 | 节点数 > 0，精简不为空，每个节点都有索引和 bounds |
| 当前 Activity | 能解析出 `包名/Activity` |
| logcat | 有界且总数一致 |
| wait-idle | 至少采样两帧 |
| key 输入 | 按 home 后前台确实变了 |
| install | 设备端 SHA256 == 本地，且**故意给错哈希时必须被拒绝** |
| launcher 解析 | 能拿到可启动组件 |

错误定位（`npm run test:crash`，制造异常再定位）：

| 测试 | 断言 |
| --- | --- |
| 故意抛出的异常 | 进程真的死了（前台已不是该 App）→ `diagnose` 解析出 `ArrayIndexOutOfBoundsException` → `location` 指向 `MainActivity.java:N` → **把源码第 N 行读出来，必须正是抛异常的那个表达式** → 截图是合法 PNG |
| 不冤枉应用 | 制造一次 `uiautomator` SIGSEGV 之后，`tombstones` 为空、`crashes` 为空，且 `ignored` 里没有本应用 |
| 修复后不再崩 | 空名单点「分摊账单」不再抛异常，应用仍在前台，结果文本保持未计算 |

最近一次结果：

```
unit : 131 pass / 0 fail   (0.4 s)
live :   9 pass / 0 fail   (25.4 s)
e2e  :   2 pass / 0 fail   (60.8 s)
crash:   3 pass / 0 fail   (58.8 s)
```

---

## 6. 已知限制

- UI 树只描述原生 view。`WebView` 内部内容需要 CDP，本工具不提供。
- **`ui` 默认只列出"屏幕上可见"的节点**——`uiautomator --compressed` 会过滤掉滚出屏幕的节点，
  于是"这一行不存在"和"这一行在屏幕外"读出来是一样的。需要区分时用 `ui --no-compressed`
  （dump 整棵树，更慢也更大），或先 `scroll` 再 dump。这个坑是端到端测试在模拟器横屏时
  真实踩到的：`tvName4` 读出 null，其实是它落在了屏幕下方。
- `uiautomator dump` 约 2 秒/次，且部分镜像会 SIGSEGV（已在读取端容忍）。
- 非 ASCII 文本输入依赖 ADBKeyboard；缺失时只输入 ASCII 部分并告警，不会静默写入别的字符串。
- `find` 默认排除 disabled 节点（对定位点击目标是对的）；要断言"某按钮是禁用的"，
  需要显式传 `enabledOnly: false`。
- 需要设备端存在 `sha256sum` 才能做安装校验；缺失时记为「跳过」而不是「失败」。
- 图片内容不同，PNG 压缩率差异很大：纯色应用界面可达 ~50x（实测 78x），照片壁纸只有 ~4x。
  真正可控的是缩放和裁剪。
