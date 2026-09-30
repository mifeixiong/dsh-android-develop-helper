import 'dart:convert';
import 'dart:io';

import 'duty.dart';
import 'native_bridge.dart';

/// Persistence inside the app's own sandbox.
///
/// The file lands in the platform's private files directory
/// (`/data/user/0/<package>/files/duty_roster.json`), so reading it from a shell
/// still needs `run-as` — which is exactly the property the live test uses to
/// prove it is reading the app's *private* state rather than something the app
/// published:
///
///     adb shell run-as com.example.dorm_duty_flutter cat files/duty_roster.json
///
/// The first version used `Directory.systemTemp`, which is the obvious choice and
/// is wrong on Android: it follows `TMPDIR`, and the file did not turn up anywhere
/// inside the sandbox afterwards. The app kept working from memory and the state
/// was simply gone on the next launch — a failure invisible enough to be worth a
/// MethodChannel to avoid. `save` therefore reports success or failure instead of
/// assuming, and the screen shows the path it actually used.
///
/// The Java example keeps its state in `SharedPreferences`; reading either one
/// exercises the same `shell "run-as <pkg> cat …"` escape hatch.
///
/// No plugin is involved, which is why this example has zero pub dependencies.
class DutyStore {
  DutyStore({Directory? root}) : _root = root;

  Directory? _root;
  String? _lastError;

  /// Why the last read or write failed, if it did.
  String? get lastError => _lastError;

  /// Resolve the directory once: platform answer first, temp dir as a fallback
  /// for host-side unit tests that have no platform behind the channel.
  Future<Directory> root() async {
    final existing = _root;
    if (existing != null) return existing;
    final native = await appFilesDir();
    final resolved = (native != null && native.isNotEmpty) ? Directory(native) : Directory.systemTemp;
    _root = resolved;
    return resolved;
  }

  Future<File> file() async {
    final dir = await root();
    return File('${dir.path}${Platform.pathSeparator}duty_roster.json');
  }

  /// Read the roster, treating "missing" and "corrupt" alike as empty.
  ///
  /// A first run and a half-written file are not worth crashing over, and the
  /// caller renders the same empty state for both.
  Future<List<DutyEntry>> load() async {
    try {
      final target = await file();
      if (!await target.exists()) return const [];
      final decoded = jsonDecode(await target.readAsString());
      if (decoded is! List) return const [];
      _lastError = null;
      return [
        for (final item in decoded)
          if (item is Map<String, dynamic>) DutyEntry.fromJson(item),
      ];
    } on Object catch (error) {
      _lastError = error.toString();
      return const [];
    }
  }

  /// Persist the roster. Returns false and records `lastError` on failure —
  /// which the caller surfaces, because a save that fails silently is the whole
  /// problem this store exists to avoid.
  Future<bool> save(List<DutyEntry> entries) async {
    try {
      final target = await file();
      await target.parent.create(recursive: true);
      await target.writeAsString(jsonEncode([for (final entry in entries) entry.toJson()]));
      _lastError = null;
      return true;
    } on Object catch (error) {
      _lastError = error.toString();
      return false;
    }
  }

  Future<void> clear() async {
    try {
      final target = await file();
      if (await target.exists()) await target.delete();
      _lastError = null;
    } on Object catch (error) {
      _lastError = error.toString();
    }
  }
}
