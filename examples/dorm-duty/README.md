# 宿舍值日提醒 (dorm-duty)

> 姊妹示例：[`../dorm-duty-flutter/`](../dorm-duty-flutter/README.md) 是同一个 App 的
> Flutter + Material 3 版本。两者用途不同——这一份证明「没有 Gradle/Flutter 的机器上也能
> 构建并驱动一个 App」，那一份证明「现代自绘 UI 框架同样能被按 id 驱动」。控件命名刻意对齐
> （`tvName1` / `tvStatus1` / `btnDone1` …），所以测试可以断言同一批选择器。

Phase 3 的验证用 App：不是插件的一部分，而是**用来验证插件**的一段真实安卓程序。

它刻意做得小而完整——一个 Activity、三天功能（值日安排 / 每日提醒 / 完成标记）、零第三方依赖——
这样"用插件把它开发出来并在模拟器上跑通"这件事的每一环都落在插件自己身上。
另外还留了两个**故意的错误入口**（账单分摊的除零、调试区的抛异常按钮），
用来验证「Logcat + 截图定位问题」这条链路。

```
examples/dorm-duty/
├── AndroidManifest.xml
├── java/com/example/dormduty/
│   ├── MainActivity.java        # 全部 UI 与交互
│   ├── DutyStore.java           # SharedPreferences + JSON 的状态层
│   ├── ReminderScheduler.java   # AlarmManager 一次性闹钟，自续期
│   └── ReminderReceiver.java    # 通知 + 频道
├── res/
│   ├── layout/activity_main.xml # 7 天值日行全部静态声明
│   └── values/{strings,colors,styles}.xml
└── build/                       # 构建产物（gitignore）
```

## 为什么是 Java + 传统 View，而不是 Kotlin + Compose

目标文档建议 Kotlin + Compose，那是**人类**开发效率最高的选择。但本 App 的用途是被 ADB 驱动，
评价标准是 `uiautomator` 读出来的界面树：

- 传统 View + 显式 `android:id` → 每个控件都是一个**唯一命名**的节点：
  `#13 Button "标记完成" id=btnDone1 @624,544 [tap]`
- Compose 默认把整棵树合并成少量语义节点，不开 `testTag` 的话，插件只能看到一大块
  `AndroidComposeView`，元素定位退化到坐标点击——那正是这套工具想摆脱的东西。

同理，7 天值日行**没有**用 `RecyclerView` + adapter：那会让 7 行共享同一批 id，
`find` 一次返回 7 个匹配项，必须靠索引消歧。静态声明多写 40 行 XML，换来的是一棵
可以按 id 直接操作的树。这个取舍在 `activity_main.xml` 顶部有注释说明。

## 构建

不需要 Gradle。工具链只用到 SDK 里的 `aapt2` / `d8` / `apksigner`：

```powershell
node tools/install-sdk.mjs                                     # 一次性：约 126 MB
node tools/build-apk.mjs --project examples/dorm-duty          # → build/dorm-duty.apk
```

构建脚本自己完成打包（`src/zip.js`），因为 `resources.arsc` 必须以 **stored + 4 字节对齐**
写入，才能走平台的 mmap 路径——Windows 上没有现成工具保证这一点。构建结束后会用真正的
`zipalign -c 4` 复核。

## 端到端验证

```powershell
npm run test:e2e     # 功能闭环
npm run test:crash   # 错误定位闭环
```

`test/dorm-duty.live.mjs` 把功能闭环跑一遍，并且**每条断言都读设备状态**：

| 步骤 | 断言 |
| --- | --- |
| 安装 | 设备端 SHA256 == 本地，包名由二进制 manifest 解析得出 |
| 清数据 + 补授权 | `pm clear` 会撤销 `install -g` 的授权，因此重新 `pm grant` |
| 启动 | `wait-activity MainActivity`，而不是 sleep |
| 空状态 | `tvRosterSummary == 还没有成员…`，且 `btnDone1` 的 enabled == false |
| 生成值日表 | 周一 zhangsan / 周二 lisi / … / 周五 zhangsan（轮值回绕） |
| 标记完成 | `tvStatus1 == 已完成`、`btnDone1 == 撤销完成`、周二不受影响 |
| 读私有状态 | `run-as … cat shared_prefs/dorm_duty.xml` 里 `done` 以 `1` 开头 |
| 清空标记 | `tvStatus1` 回到 `未完成` |
| 开启提醒 | `tvReminderStatus == 已开启`，且 `dumpsys alarm` 里出现 `RTC_WAKEUP … .REMIND` |
| 测试通知 | `dumpsys notification` 里有 `pkg=com.example.dormduty` 且频道为 `dorm_duty_reminder` |

跑通一次约 60 秒，其中大部分是 `uiautomator dump`（约 2 秒/次）。

## 错误定位闭环（`npm run test:crash`）

App 里有两条会失败的路径，都是真会写出来的那种错：

| 入口 | 错误 | 真实原因 |
| --- | --- | --- |
| 账单分摊 → `splitBill()` | `ArithmeticException: divide by zero` | 用**整数分**做除法，空名单时 `totalCents / 0` 抛异常 |
| 调试 → 「触发一个异常」 | `ArrayIndexOutOfBoundsException: length=0; index=0` | `members[members.length]`，刻意留的越界 |

> 第一版 `splitBill()` 用的是 `double`，结果 `120.0 / 0` 是 `Infinity` 而不是异常——**什么都没崩**，
> 只是安静地算出一个无穷大的金额。这本身就是值得留档的一课：浮点除零不报错，
> 所以「金额按分存整数」既是正确做法，也是让这个 bug 变成可发现 bug 的原因。

`test/crash.live.mjs` 断言的不只是「插件说崩了」，而是：

1. 进程**真的死了**——前台不再是本 App（独立于日志的第二份证据）；
2. `diagnose` 解析出正确的异常类型、线程、进程；
3. `location` 指向的 `File.java:N`，**把源码第 N 行读出来必须正好是抛异常的那个表达式**；
4. 截图是合法 PNG（错误现场）。

修好之后（监听器改调 `splitBillFixed()`）同一个测试再跑一遍，要求进程不死、无崩溃、结果未计算。
「能定位」和「修复生效」是同一个测试的两半。

## 一个真实踩到的坑

第一次带 `android:debuggable="true"` 重建后安装，插件报：

```
安装失败 [INSTALL_FAILED_UPDATE_INCOMPATIBLE]: 设备上已安装的包与新 APK 签名不一致
```

原因有两个，都被这次验证暴露出来：

1. **构建脚本把签名密钥放在了每次都会清空的 `build/` 里** → 每次构建生成新密钥。
   现在密钥固定落在 `examples/dorm-duty/debug.keystore`，并且**已随仓库提交**（`.gitignore`
   里刻意不忽略它）。这是刻意的：这是一把一次性的调试密钥，公开它没有代价，而让每个
   克隆都用同一把，`install -r` 升级才不会因为签名变化被拒。
2. **`adb install` 会同时打印 `Success:` 和 `Failure [...]` 并返回 0**：

   ```
   Performing Streamed Install
   Success: streamed 37341 bytes
   Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: … signatures do not match …]
   ```

   `Success:` 说的是**字节流**，不是包提交。原来那句 `/Success/ && exit === 0` 会把
   "什么都没装" 判成成功。现在 `classifyInstallOutput()` 以 `Failure [CODE]` 为准，
   并把常见错误码翻译成下一步动作（`src/app.js`，附回归测试）。

这正是这套工具坚持"装完必验"的理由：`adb install` 的成功信息不可信。

## 已知限制

- 成员名用 ASCII 拼音（`zhangsan,lisi,…`）。中文文本输入需要设备安装 ADBKeyboard IME；
  没装时插件会**明确告警并只输入 ASCII 部分**，而不是悄悄写入别的字符串。
  这一行为在验证里也跑过（输入"张三,李四" → 只落下一个逗号 + warning）。
- `android:debuggable="true"` 是刻意的：它让 `run-as` 可用，从而能直接读 App 私有状态。
  正式发布当然要去掉。
- 提醒时间固定 21:30，用 `setAndAllowWhileIdle` 自续期，不申请 `SCHEDULE_EXACT_ALARM`。
