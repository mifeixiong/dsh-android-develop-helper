/// Duty-roster domain model.
///
/// Deliberately free of Flutter imports: the rotation rule and the (broken) bill
/// split are plain Dart so they can be unit-tested without a widget binding, the
/// same separation the Java example keeps between `DutyStore` and `MainActivity`.
library;

/// The five weekdays this roster covers.
const List<String> weekDays = ['周一', '周二', '周三', '周四', '周五'];

/// One weekday's assignment.
class DutyEntry {
  DutyEntry({required this.day, required this.name, this.done = false});

  final String day;
  final String name;
  bool done;

  Map<String, dynamic> toJson() => {'day': day, 'name': name, 'done': done};

  static DutyEntry fromJson(Map<String, dynamic> json) => DutyEntry(
        day: json['day'] as String? ?? '',
        name: json['name'] as String? ?? '',
        done: json['done'] as bool? ?? false,
      );
}

/// Build a rotating roster: member `i % members.length` takes day `i`.
///
/// The Java example uses the same rule, so the live tests can assert the same
/// names on the same weekdays against either app.
List<DutyEntry> buildRoster(List<String> members) {
  if (members.isEmpty) return const [];
  return [
    for (var i = 0; i < weekDays.length; i++)
      DutyEntry(day: weekDays[i], name: members[i % members.length]),
  ];
}

int doneCount(List<DutyEntry> entries) => entries.where((e) => e.done).length;

/// Split a bill in whole cents — **deliberately unguarded**.
///
/// An empty roster divides by zero. This is the bug the crash test drives: it is
/// a real mistake, not a synthetic `throw`, and it is the integer version of it.
/// A `double` would quietly yield `Infinity` instead, which is harder to notice
/// and therefore the worse bug to ship.
int splitBill(int totalCents, int members) => totalCents ~/ members;

/// The fixed version, used by the test that proves the reported line really was
/// the cause.
int splitBillFixed(int totalCents, int members) {
  if (members <= 0) return 0;
  return totalCents ~/ members;
}

/// Raise an error for the logcat test to localise.
///
/// Written as a plain out-of-range read rather than a `throw`, so the frame the
/// analyser reports is a real fault site in this file — which is what lets the
/// crash test read the reported line back out of `duty.dart` and check it.
int triggerValidationCrash() {
  final empty = <int>[];
  return empty[3];
}
