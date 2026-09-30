import 'package:flutter/material.dart';

import 'duty_page.dart';
import 'theme.dart';

void main() {
  // Report uncaught Dart errors through `debugPrint`, so the full stack reaches
  // logcat on the `flutter` tag in every build mode.
  //
  // This is not a workaround for a quirk of the toolkit — it is what Flutter's
  // own error handling leaves on the table. Measured on this emulator:
  //
  //   - a **debug** APK launched without an attached VM service printed nothing
  //     at all;
  //   - a **profile** APK printed the exception and the stack, but with the
  //     frames inlined away (`_splitBill (package:…/duty_page.dart)` — no line),
  //     so there was nothing to open;
  //   - with this hook, both print `Unhandled Exception: …` followed by
  //     `#0 … (package:…/duty.dart:48:38)`, which is the shape
  //     `android_logcat`'s crash parser reads.
  //
  // An app shipping to users would forward the same callback to a crash
  // reporter. The shape is identical; only the destination differs.
  final previous = FlutterError.onError;
  FlutterError.onError = (details) {
    final error = details.exception;
    if (error is FlutterError) {
      // A framework assertion — a bad layout, an invisible ink splash — is
      // reported through the same callback as an uncaught error but is not one.
      // Labeling it "Unhandled Exception" would make the log claim the app
      // crashed while it is running fine, and would send an agent looking for a
      // stack that is not the problem.
      debugPrint('Framework error: ${details.exceptionAsString()}');
      debugPrintStack(stackTrace: details.stack);
      previous?.call(details);
      return;
    }
    debugPrint('Unhandled Exception: ${details.exceptionAsString()}');
    debugPrintStack(stackTrace: details.stack);
    previous?.call(details);
  };

  runApp(const DormDutyApp());
}

/// 宿舍值日 — the Flutter counterpart to `examples/dorm-duty` (Java + classic
/// Views).
///
/// It exists to answer one question the Java example cannot: *can this toolkit
/// drive a modern UI framework?* The answer hinges on `Semantics(identifier:)`,
/// which Flutter maps to `AccessibilityNodeInfo.setViewIdResourceName` on
/// Android — i.e. to the `resource-id` that `android_ui` prints and `android_tap`
/// matches on. Every interactive control below therefore carries one.
class DormDutyApp extends StatelessWidget {
  const DormDutyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: '宿舍值日',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      home: const DutyPage(),
    );
  }
}
