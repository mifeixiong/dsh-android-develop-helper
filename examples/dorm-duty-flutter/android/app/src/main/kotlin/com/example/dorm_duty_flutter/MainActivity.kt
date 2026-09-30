package com.example.dorm_duty_flutter

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/**
 * The Android half of `lib/native_bridge.dart`.
 *
 * Flutter cannot post a notification by itself, and reaching for a plugin would
 * add this example's first pub dependency plus another surface to keep current.
 * The platform code `flutter create` already generated is the smaller answer, and
 * it keeps the boundary honest: posting a notification *is* platform work.
 *
 * `flutter_local_notifications` is the right call for an app that needs
 * scheduling, actions or a custom layout. This one needs "show a reminder now",
 * which the framework API already does — and the channel id below is what the
 * live test asserts against `dumpsys notification`.
 */
class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        ensureChannel()

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, CHANNEL)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "postReminder" -> {
                        post(
                            call.argument<String>("title") ?: "宿舍值日",
                            call.argument<String>("body") ?: "",
                        )
                        result.success(NOTIFICATION_CHANNEL_ID)
                    }

                    "hasPermission" -> result.success(hasNotificationPermission())

                    // The app's private files directory. Dart's
                    // `Directory.systemTemp` follows TMPDIR, which on Android is
                    // not reliably inside the sandbox — a roster written there is
                    // invisible to `run-as`, so the app looks fine and its state
                    // is quietly missing. The platform knows the real answer.
                    "filesDir" -> result.success(filesDir.absolutePath)

                    else -> result.notImplemented()
                }
            }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(NOTIFICATION_CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(
                NOTIFICATION_CHANNEL_ID,
                "值日提醒",
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply { description = "宿舍值日的每日提醒" },
        )
    }

    private fun hasNotificationPermission(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
        return checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
    }

    private fun post(title: String, body: String) {
        if (!hasNotificationPermission()) return
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, NOTIFICATION_CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        val notification = builder
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .build()
        (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
            .notify(NOTIFICATION_ID, notification)
    }

    companion object {
        private const val CHANNEL = "dorm_duty_flutter/native"
        private const val NOTIFICATION_CHANNEL_ID = "dorm_duty_reminder"
        private const val NOTIFICATION_ID = 1001
    }
}
