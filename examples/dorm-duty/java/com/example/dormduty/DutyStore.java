package com.example.dormduty;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONException;

import java.util.ArrayList;
import java.util.List;

/**
 * Persistence for the duty roster.
 *
 * Deliberately a thin wrapper over {@link SharedPreferences} holding a JSON
 * array: the app exists to exercise the emulator tooling, so its state layer
 * should be inspectable with nothing more than `adb shell run-as` — no database,
 * no migration machinery, no schema to explain.
 */
public final class DutyStore {

    /** One entry per weekday, Monday first. */
    public static final int DAYS = 7;

    private static final String PREFS = "dorm_duty";
    private static final String KEY_MEMBERS = "members";
    private static final String KEY_DONE = "done";
    private static final String KEY_ENABLED = "reminder_enabled";
    private static final String KEY_HOUR = "reminder_hour";
    private static final String KEY_MINUTE = "reminder_minute";

    public static final int DEFAULT_HOUR = 21;
    public static final int DEFAULT_MINUTE = 30;

    private DutyStore() {
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Member names in roster order; empty when no roster has been generated. */
    public static String[] members(Context context) {
        String raw = prefs(context).getString(KEY_MEMBERS, "[]");
        try {
            JSONArray array = new JSONArray(raw);
            List<String> names = new ArrayList<>(array.length());
            for (int i = 0; i < array.length(); i++) {
                String name = array.optString(i, "").trim();
                if (!name.isEmpty()) {
                    names.add(name);
                }
            }
            return names.toArray(new String[0]);
        } catch (JSONException e) {
            return new String[0];
        }
    }

    public static void saveMembers(Context context, String[] members) {
        JSONArray array = new JSONArray();
        for (String member : members) {
            array.put(member);
        }
        prefs(context).edit().putString(KEY_MEMBERS, array.toString()).apply();
    }

    public static boolean[] done(Context context) {
        String raw = prefs(context).getString(KEY_DONE, "");
        boolean[] flags = new boolean[DAYS];
        if (raw.length() == DAYS) {
            for (int i = 0; i < DAYS; i++) {
                flags[i] = raw.charAt(i) == '1';
            }
        }
        return flags;
    }

    public static void setDone(Context context, int day, boolean value) {
        boolean[] flags = done(context);
        if (day < 0 || day >= DAYS) {
            return;
        }
        flags[day] = value;
        StringBuilder builder = new StringBuilder(DAYS);
        for (boolean flag : flags) {
            builder.append(flag ? '1' : '0');
        }
        prefs(context).edit().putString(KEY_DONE, builder.toString()).apply();
    }

    public static void resetDone(Context context) {
        prefs(context).edit().putString(KEY_DONE, "0000000").apply();
    }

    public static boolean reminderEnabled(Context context) {
        return prefs(context).getBoolean(KEY_ENABLED, false);
    }

    public static void setReminderEnabled(Context context, boolean enabled) {
        prefs(context).edit().putBoolean(KEY_ENABLED, enabled).apply();
    }

    public static int reminderHour(Context context) {
        return prefs(context).getInt(KEY_HOUR, DEFAULT_HOUR);
    }

    public static int reminderMinute(Context context) {
        return prefs(context).getInt(KEY_MINUTE, DEFAULT_MINUTE);
    }

    /** Who is on duty for a weekday index, by round robin over the roster. */
    public static String assignee(String[] members, int day) {
        if (members.length == 0) {
            return "";
        }
        return members[day % members.length];
    }

    /**
     * Today as a Monday-based index.
     * {@link java.util.Calendar} uses Sunday = 1, so Sunday becomes 6.
     */
    public static int todayIndex() {
        java.util.Calendar calendar = java.util.Calendar.getInstance();
        int dayOfWeek = calendar.get(java.util.Calendar.DAY_OF_WEEK);
        return (dayOfWeek + 5) % 7;
    }
}
