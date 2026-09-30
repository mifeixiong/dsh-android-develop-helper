package com.example.dormduty;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import java.util.Calendar;

/**
 * One-shot alarm scheduling for the daily reminder.
 *
 * Kept separate from the receiver so the UI can show the next fire time without
 * constructing a notification.
 */
public final class ReminderScheduler {

    private static final int REQUEST_CODE = 2001;

    private ReminderScheduler() {
    }

    private static PendingIntent pendingIntent(Context context) {
        Intent intent = new Intent(context, ReminderReceiver.class);
        intent.setAction(ReminderReceiver.ACTION_REMIND);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getBroadcast(context, REQUEST_CODE, intent, flags);
    }

    /** Milliseconds until the next occurrence of the configured time. */
    public static long nextTriggerAt(Context context) {
        Calendar next = Calendar.getInstance();
        next.set(Calendar.HOUR_OF_DAY, DutyStore.reminderHour(context));
        next.set(Calendar.MINUTE, DutyStore.reminderMinute(context));
        next.set(Calendar.SECOND, 0);
        next.set(Calendar.MILLISECOND, 0);
        if (next.getTimeInMillis() <= System.currentTimeMillis()) {
            next.add(Calendar.DAY_OF_YEAR, 1);
        }
        return next.getTimeInMillis();
    }

    public static void scheduleNext(Context context) {
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) {
            return;
        }
        long triggerAt = nextTriggerAt(context);
        PendingIntent pending = pendingIntent(context);
        // setAndAllowWhileIdle needs no special permission and still fires in
        // Doze, which is all a "remember to sweep" nudge requires.
        manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pending);
    }

    public static void cancel(Context context) {
        AlarmManager manager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (manager != null) {
            manager.cancel(pendingIntent(context));
        }
    }

    /** "21:30" for the status line. */
    public static String describeTime(Context context) {
        return String.format(java.util.Locale.US, "%02d:%02d",
                DutyStore.reminderHour(context), DutyStore.reminderMinute(context));
    }
}
