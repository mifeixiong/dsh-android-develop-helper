import 'package:flutter/services.dart';

/// Bridge to the Android side, which lives in `android/app/src/main/kotlin/…`.
///
/// Flutter has no notification API of its own, and the obvious fix — a plugin —
/// would be this example's first pub dependency and its first piece of rot. The
/// platform code `flutter create` already generates is the smaller answer, and it
/// keeps the boundary honest: posting a notification *is* platform work.
const MethodChannel _channel = MethodChannel('dorm_duty_flutter/native');

/// Post a reminder on the app's own notification channel.
///
/// Returns the channel id the platform used, which is what the live test asserts
/// against `dumpsys notification`.
Future<String> postReminder({required String title, required String body}) async {
  final channel = await _channel.invokeMethod<String>('postReminder', {
    'title': title,
    'body': body,
  });
  return channel ?? 'unknown';
}

/// Whether POST_NOTIFICATIONS is granted (Android 13+ always asks).
Future<bool> hasNotificationPermission() async {
  return await _channel.invokeMethod<bool>('hasPermission') ?? true;
}

/// The app's private files directory, or null when there is no platform.
///
/// `Directory.systemTemp` is the obvious first attempt and it is a trap: on
/// Android it follows `TMPDIR`, and a file written there did not appear anywhere
/// inside the sandbox — so `run-as … cat files/…` found nothing while the app
/// happily kept working from memory. Asking the platform removes the guess.
Future<String?> appFilesDir() async {
  try {
    return await _channel.invokeMethod<String>('filesDir');
  } on MissingPluginException {
    // Host-side `flutter test` has no platform; the caller falls back.
    return null;
  } on PlatformException {
    return null;
  }
}
