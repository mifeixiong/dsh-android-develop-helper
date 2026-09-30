import 'package:dorm_duty_flutter/duty.dart';
import 'package:flutter_test/flutter_test.dart';

/// Plain-Dart tests for the domain rules.
///
/// They mirror the Java example's `DutyStore` tests on purpose: the rotation and
/// the bill split are the same rules in both apps, so a live test can assert the
/// same names on the same weekdays whichever one it is driving.
void main() {
  test('every weekday gets a member, wrapping around the list', () {
    final roster = buildRoster(['zhangsan', 'lisi']);
    expect(roster.map((entry) => entry.day).toList(), weekDays);
    expect(
      roster.map((entry) => entry.name).toList(),
      ['zhangsan', 'lisi', 'zhangsan', 'lisi', 'zhangsan'],
    );
  });

  test('an empty roster list produces no entries rather than throwing', () {
    expect(buildRoster(const []), isEmpty);
    expect(buildRoster(const ['   '].where((n) => n.trim().isNotEmpty).toList()), isEmpty);
  });

  test('nobody starts the day finished', () {
    for (final entry in buildRoster(['zhangsan', 'lisi'])) {
      expect(entry.done, isFalse);
    }
    expect(doneCount(buildRoster(['zhangsan', 'lisi'])), 0);
  });

  test('a roster survives a JSON round trip', () {
    final roster = buildRoster(['zhangsan', 'lisi'])..first.done = true;
    final restored = [for (final entry in roster) DutyEntry.fromJson(entry.toJson())];
    expect(restored.length, roster.length);
    expect(restored.first.done, isTrue);
    expect(restored.first.name, roster.first.name);
    expect(restored.last.day, '周五');
  });

  test('the broken split divides by zero on an empty roster', () {
    // Not a synthetic throw: this is the bug the crash test localises.
    expect(() => splitBill(12800, 0), throwsA(isA<Error>()));
  });

  test('the fixed split returns zero instead of throwing', () {
    expect(splitBillFixed(12800, 0), 0);
    expect(splitBillFixed(12800, 4), 3200);
  });

  test('the validation crash throws an index error', () {
    expect(triggerValidationCrash, throwsA(isA<RangeError>()));
  });
}
