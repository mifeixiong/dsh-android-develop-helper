# 宿舍值日（Flutter）

`examples/dorm-duty` 的 Flutter 版本。两个示例做同一件事，用途不同：

| | [dorm-duty](../dorm-duty/README.md) | dorm-duty-flutter（本目录） |
| --- | --- | --- |
| 技术栈 | Java + 传统 View（`findViewById` + 显式 `android:id`） | Dart + Flutter + Material 3 |
| 构建 | 免 Gradle（`tools/build-apk.mjs`：aapt2 → javac → d8 → 自研打包 → apksigner） | `flutter build apk`（需要 Flutter SDK 与 Gradle） |
| 验证的是 | 工具箱在**没有 Flutter/Gradle 的机器上**也能构建并驱动一个 App | 工具箱能不能驱动**现代自绘 UI 框架** |

## 为什么 Flutter 也能被按 id 驱动

直觉是"Flutter 用 Skia 自绘，`uiautomator` 只能看到一个 `FlutterView`，所以只能坐标点击"。
这句只对了一半——Flutter 会把语义树镜像进 Android 的无障碍层级，而
[`SemanticsProperties.identifier`](https://api.flutter.dev/flutter/semantics/SemanticsProperties/identifier.html)
的文档写得很直接：

> On Android, this is used for `AccessibilityNodeInfo.setViewIdResourceName`.
> It'll be appear in accessibility hierarchy as `resource-id`.

也就是 `Semantics(identifier: 'tvStatus1', …)` 在 `uiautomator` 眼里就是
`resource-id="tvStatus1"`，跟传统 View 的 `android:id="@+id/tvStatus1"` 走同一条路。
本目录里每个可交互控件都带一个 identifier，命名与传统 View 版保持一致
（`tvName1` / `tvStatus1` / `btnDone1` / `btnGenerate` / `btnTestCrash` …），
两套 App 的测试因此可以断言同一批选择器。实测输出：

```
$ node ../../bin/android-helper.mjs ui --max 40
#2 View desc="0 / 0" id=tvProgress @114,183
#6 View desc="还没有值日表" id=tvEmpty @360,590
#9 Button desc="生成值日表" id=btnGenerate @592,1214
```

## 三件实测出来的事

- **文本在 `content-desc`，不在 `android:text`。** 工具箱的 `text` 选择器为此改成两者都匹配
  （否则 `tap-text "生成值日表"` 找不到一个 `ui` 刚以 `desc=…` 打印出来的节点）。
- **只有屏幕内的语义节点会被上报。** 滚出视口的控件在无障碍树里**根本不存在**，
  `ui --no-compressed` 也拿不到——所以要 `scrollTo` 之后再定位。
- **`Text` 不创建自己的语义节点**，label 会落到最近的语义祖先（也就是带 identifier 的节点），
  因此文本行不必额外写 `label`；按钮**会**创建自己的节点，所以 `lib/duty_page.dart` 里用
  `Semantics(identifier: …, label: …, excludeSemantics: true)` 把文案收回同一个节点，
  否则 identifier 所在节点点得中却读不到字。

## 崩溃定位的差别

Java 版的崩溃是 `FATAL EXCEPTION`，进程会死。Dart 的未捕获异常**不会杀进程**，而且行号只存在
于 debug 构建里：

| 构建 | logcat 里有什么 |
| --- | --- |
| `--debug`（JIT） | `Unhandled Exception: IntegerDivisionByZeroException` + `#1 splitBill (package:dorm_duty_flutter/duty.dart:48:58)` |
| `--profile`（AOT） | 异常和帧都在，但帧被 AOT 内联成 `_splitBill (package:…/duty_page.dart)`——没有行号 |
| `--release` | 只有异常类型，没有 Dart 栈 |

三种情况在模拟器上都实测过。`lib/main.dart` 里的 `FlutterError.onError` 钩子把未捕获错误的完整
堆栈经 `debugPrint` 写到 `flutter` 标签上，这是让「从 logcat 定位到行」在 Flutter 上成立的
前提（Flutter 自己的输出在 debug 且无 VM service 时什么都不打）。它同时把框架断言标成
`Framework error:`，不与真正的未捕获异常混淆。

```
崩溃: IntegerDivisionByZeroException
  定位: duty.dart:48  ← splitBill
```

## 私有状态：不要用 `Directory.systemTemp`

第一版把值日表写到 `Directory.systemTemp`，结果**文件根本没落进应用沙箱**——
`/data/user/0/<包名>/` 下的 `cache/`、`files/`、`app_flutter/` 全是空的，
而 App 照常工作（状态在内存里）。`systemTemp` 跟随 `TMPDIR`，在 Android 上不保证位于沙箱内。

现在路径由平台给：`lib/native_bridge.dart` 通过一个 MethodChannel 取 Android 的 `filesDir`
（`android/app/src/main/kotlin/…/MainActivity.kt`），文件落在
`/data/user/0/com.example.dorm_duty_flutter/files/duty_roster.json`。读取仍然需要 `run-as`：

```powershell
node ../../bin/android-helper.mjs shell "run-as com.example.dorm_duty_flutter cat files/duty_roster.json"
```

`save()` 现在返回成功与否并记录错误，界面上的「验证用」面板会显示实际写入路径
（`tvStorePath`）——静默失败是这次唯一的教训。

## 依赖

`pubspec.yaml` 里没有任何第三方包，这是刻意的：持久化走 `dart:io`，通知走一个约二十行的
MethodChannel。`flutter pub get` 因此不需要访问网络，示例也不会因为某个包变更而失效。

## 构建与测试

```powershell
flutter pub get
flutter analyze                        # 无 lint 预设，只看错误与默认告警
flutter test                           # 纯 Dart 逻辑测试（7 个）
flutter build apk --profile --target-platform android-x64    # 端到端测试用
flutter build apk --debug   --target-platform android-x64    # 崩溃定位测试用（行号）
```

工具箱侧的测试：

```powershell
npm run test:flutter        # 2 个端到端测试，用 profile APK
npm run test:flutter:crash  # 2 个崩溃定位测试，用 debug APK
```

两个套件装在同一个 applicationId 上，会互相覆盖安装——各自安装自己需要的产物，这是有意的。
