package com.example.dormduty;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * Posts the "it is your turn" notification and reschedules the next one.
 *
 * The alarm is a one-shot {@code setAndAllowWhileIdle} that reschedules itself
 * rather than a repeating alarm: repeating alarms drift and cannot be moved to a
 * different time without being cancelled first, and exact alarms need the
 * {@code SCHEDULE_EXACT_ALARM} permission from API 31 which this app does not
 * want to ask for.
 */
public class ReminderReceiver extends BroadcastReceiver {

    public static final String CHANNEL_ID = "dorm_duty_reminder";
    public static final String CHANNEL_NAME = "值日提醒";
    public static final int NOTIFICATION_ID = 1001;
    public static final String ACTION_REMIND = "com.example.dormduty.REMIND";

    @Override
    public void onReceive(Context context, Intent intent) {
        String[] members = DutyStore.members(context);
        if (members.length > 0) {
            postNow(context, members);
        }
        if (DutyStore.reminderEnabled(context)) {
            ReminderScheduler.scheduleNext(context);
        }
    }

    /** Post the reminder immediately, naming today's assignee. */
    public static void postNow(Context context, String[] members) {
        int today = DutyStore.todayIndex();
        String assignee = DutyStore.assignee(members, today);
        boolean finished = DutyStore.done(context)[today];
        String title = context.getString(R.string.notification_title);
        String body = finished
                ? context.getString(R.string.notification_body_done, assignee)
                : context.getString(R.string.notification_body, assignee);

        ensureChannel(context);

        Intent open = new Intent(context, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent contentIntent = PendingIntent.getActivity(context, 0, open, flags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(context, CHANNEL_ID)
                : new Notification.Builder(context);
        Notification notification = builder
                .setContentTitle(title)
                .setContentText(body)
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setAutoCancel(true)
                .setContentIntent(contentIntent)
                .build();

        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, notification);
        }
    }

    /** Create the notification channel on API 26+; harmless to call repeatedly. */
    public static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null || manager.getNotificationChannel(CHANNEL_ID) != null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription(context.getString(R.string.channel_description));
        manager.createNotificationChannel(channel);
    }
}
