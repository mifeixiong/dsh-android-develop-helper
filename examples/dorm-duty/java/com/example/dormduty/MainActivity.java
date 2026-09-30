package com.example.dormduty;

import android.Manifest;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;

/**
 * The whole UI.
 *
 * Every interactive element carries an explicit {@code android:id} and the seven
 * weekday rows are declared statically rather than inflated from an adapter.
 * That is a deliberate trade: this app exists to be driven over ADB, and
 * {@code uiautomator} reports a stable, uniquely named node for each control
 * only when the ids are distinct. A {@code RecyclerView} would be less XML and a
 * far worse automation target.
 */
public class MainActivity extends Activity {

    private static final String[] DAY_LABELS = {"周一", "周二", "周三", "周四", "周五", "周六", "周日"};

    private static final int[] DAY_IDS = {
            R.id.tvDay1, R.id.tvDay2, R.id.tvDay3, R.id.tvDay4, R.id.tvDay5, R.id.tvDay6, R.id.tvDay7,
    };
    private static final int[] NAME_IDS = {
            R.id.tvName1, R.id.tvName2, R.id.tvName3, R.id.tvName4, R.id.tvName5, R.id.tvName6, R.id.tvName7,
    };
    private static final int[] STATUS_IDS = {
            R.id.tvStatus1, R.id.tvStatus2, R.id.tvStatus3, R.id.tvStatus4,
            R.id.tvStatus5, R.id.tvStatus6, R.id.tvStatus7,
    };
    private static final int[] DONE_IDS = {
            R.id.btnDone1, R.id.btnDone2, R.id.btnDone3, R.id.btnDone4,
            R.id.btnDone5, R.id.btnDone6, R.id.btnDone7,
    };

    private EditText etMembers;
    private TextView tvRosterSummary;
    private TextView tvScheduleEmpty;
    private EditText etBillAmount;
    private TextView tvBillResult;
    private TextView tvReminderStatus;
    private TextView tvReminderTime;
    private Button btnToggleReminder;

    private final TextView[] dayViews = new TextView[DutyStore.DAYS];
    private final TextView[] nameViews = new TextView[DutyStore.DAYS];
    private final TextView[] statusViews = new TextView[DutyStore.DAYS];
    private final Button[] doneButtons = new Button[DutyStore.DAYS];

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        etMembers = findViewById(R.id.etMembers);
        tvRosterSummary = findViewById(R.id.tvRosterSummary);
        tvScheduleEmpty = findViewById(R.id.tvScheduleEmpty);
        etBillAmount = findViewById(R.id.etBillAmount);
        tvBillResult = findViewById(R.id.tvBillResult);
        tvReminderStatus = findViewById(R.id.tvReminderStatus);
        tvReminderTime = findViewById(R.id.tvReminderTime);
        btnToggleReminder = findViewById(R.id.btnToggleReminder);

        for (int day = 0; day < DutyStore.DAYS; day++) {
            dayViews[day] = findViewById(DAY_IDS[day]);
            nameViews[day] = findViewById(NAME_IDS[day]);
            statusViews[day] = findViewById(STATUS_IDS[day]);
            doneButtons[day] = findViewById(DONE_IDS[day]);
            dayViews[day].setText(DAY_LABELS[day]);

            final int index = day;
            doneButtons[day].setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View view) {
                    toggleDone(index);
                }
            });
        }

        findViewById(R.id.btnGenerate).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                generate();
            }
        });
        findViewById(R.id.btnExample).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                etMembers.setText(R.string.example_roster);
                generate();
            }
        });
        findViewById(R.id.btnResetDone).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                DutyStore.resetDone(MainActivity.this);
                render();
                toast(getString(R.string.toast_reset_done));
            }
        });
        btnToggleReminder.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                toggleReminder();
            }
        });
        findViewById(R.id.btnTestReminder).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                testReminder();
            }
        });
        findViewById(R.id.btnSplitBill).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                // Was splitBill(): it threw ArithmeticException at MainActivity:197 when
                // the roster was empty. Located with `android-helper diagnose`, fixed
                // here, and covered by test/dorm-duty.live.mjs so it cannot come back.
                splitBillFixed();
            }
        });
        findViewById(R.id.btnCrash).setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                triggerValidationCrash();
            }
        });

        ReminderReceiver.ensureChannel(this);
        requestNotificationPermissionIfNeeded();
        render();
    }

    // ── actions ─────────────────────────────────────────────────────────────

    private void generate() {
        String[] members = parseMembers(etMembers.getText().toString());
        if (members.length == 0) {
            toast(getString(R.string.toast_need_members));
            return;
        }
        DutyStore.saveMembers(this, members);
        DutyStore.resetDone(this);
        render();
        toast(getString(R.string.toast_generated, members.length));
    }

    private void toggleDone(int day) {
        boolean[] done = DutyStore.done(this);
        DutyStore.setDone(this, day, !done[day]);
        render();
    }

    private void toggleReminder() {
        boolean enabled = !DutyStore.reminderEnabled(this);
        DutyStore.setReminderEnabled(this, enabled);
        if (enabled) {
            ReminderScheduler.scheduleNext(this);
        } else {
            ReminderScheduler.cancel(this);
        }
        render();
        toast(getString(enabled ? R.string.toast_reminder_on : R.string.toast_reminder_off));
    }

    private void testReminder() {
        String[] members = DutyStore.members(this);
        if (members.length == 0) {
            toast(getString(R.string.toast_need_members));
            return;
        }
        ReminderReceiver.postNow(this, members);
        toast(getString(R.string.toast_reminder_sent));
    }

    /**
     * Split a bill across the roster.
     *
     * Intentionally unvalidated. Two mistakes a developer actually makes:
     * a blank amount throws {@link NumberFormatException}, and an empty roster
     * divides an **int** by zero — `double / 0` would quietly be `Infinity`, so
     * the integer-cents form is what makes this a real crash rather than a
     * silently wrong number.
     *
     * `splitBillFixed()` below is the corrected version.
     */
    private void splitBill() {
        int totalCents = (int) Math.round(Double.parseDouble(etBillAmount.getText().toString().trim()) * 100);
        String[] members = DutyStore.members(this);
        int eachCents = totalCents / members.length;
        tvBillResult.setText(getString(R.string.bill_result, members.length, eachCents / 100.0));
        toast(getString(R.string.toast_bill_split));
    }

    /** The validated version, kept so the fix is visible in one file. */
    private void splitBillFixed() {
        String raw = etBillAmount.getText().toString().trim();
        if (raw.isEmpty()) {
            toast(getString(R.string.toast_need_amount));
            return;
        }
        double amount;
        try {
            amount = Double.parseDouble(raw);
        } catch (NumberFormatException e) {
            toast(getString(R.string.toast_bad_amount));
            return;
        }
        String[] members = DutyStore.members(this);
        if (members.length == 0) {
            toast(getString(R.string.toast_need_members));
            return;
        }
        int totalCents = (int) Math.round(amount * 100);
        int eachCents = totalCents / members.length;
        tvBillResult.setText(getString(R.string.bill_result, members.length, eachCents / 100.0));
        toast(getString(R.string.toast_bill_split));
    }

    /**
     * Throw on purpose.
     *
     * This button exists so the toolchain can be exercised against a real
     * FATAL EXCEPTION with a known `file:line`, without waiting for a genuine bug
     * to appear. The off-by-one is deliberate and the stack trace it produces is
     * the exact shape a real index bug produces.
     */
    private void triggerValidationCrash() {
        String[] members = DutyStore.members(this);
        int index = members.length;
        tvBillResult.setText(members[index]);
    }

    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return;
        }
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 100);
    }

    // ── rendering ───────────────────────────────────────────────────────────

    private void render() {
        String[] members = DutyStore.members(this);
        boolean[] done = DutyStore.done(this);

        for (int day = 0; day < DutyStore.DAYS; day++) {
            String assignee = DutyStore.assignee(members, day);
            nameViews[day].setText(assignee.isEmpty() ? getString(R.string.not_assigned) : assignee);
            statusViews[day].setText(done[day] ? R.string.status_done : R.string.status_pending);
            statusViews[day].setTextColor(resolveColor(done[day] ? R.color.status_done : R.color.status_pending));
            doneButtons[day].setText(done[day] ? R.string.action_undo : R.string.action_done);
            doneButtons[day].setEnabled(!assignee.isEmpty());
        }

        if (members.length == 0) {
            tvRosterSummary.setText(R.string.roster_empty);
            tvScheduleEmpty.setVisibility(View.VISIBLE);
        } else {
            tvRosterSummary.setText(getString(R.string.roster_summary, members.length));
            tvScheduleEmpty.setVisibility(View.GONE);
        }
        if (etMembers.getText().length() == 0 && members.length > 0) {
            etMembers.setText(join(members));
        }

        boolean enabled = DutyStore.reminderEnabled(this);
        btnToggleReminder.setText(enabled ? R.string.action_reminder_off : R.string.action_reminder_on);
        tvReminderStatus.setText(enabled ? R.string.reminder_on : R.string.reminder_off);
        tvReminderTime.setText(getString(R.string.reminder_time, ReminderScheduler.describeTime(this)));
    }

    // ── helpers ─────────────────────────────────────────────────────────────

    /** Split on commas and the full-width / Chinese separators a phone keyboard produces. */
    private static String[] parseMembers(String raw) {
        List<String> names = new ArrayList<>();
        for (String token : raw.split("[,，、;；\\s]+")) {
            String name = token.trim();
            if (!name.isEmpty()) {
                names.add(name);
            }
        }
        return names.toArray(new String[0]);
    }

    private static String join(String[] members) {
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < members.length; i++) {
            if (i > 0) {
                builder.append(',');
            }
            builder.append(members[i]);
        }
        return builder.toString();
    }

    /** Named `resolveColor` because `Context.getColor` is final and cannot be shaded. */
    @SuppressWarnings("deprecation")
    private int resolveColor(int resId) {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.M
                ? getResources().getColor(resId, getTheme())
                : getResources().getColor(resId);
    }

    private void toast(String message) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
    }
}
