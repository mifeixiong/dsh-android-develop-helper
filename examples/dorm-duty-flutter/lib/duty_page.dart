import 'package:flutter/material.dart';

import 'duty.dart';
import 'duty_store.dart';
import 'native_bridge.dart';
import 'theme.dart';

/// The roster screen.
///
/// Every control a test or an agent has to reach carries a
/// `Semantics(identifier: …)`. On Android Flutter turns that identifier into
/// `AccessibilityNodeInfo.viewIdResourceName`, which is what `uiautomator`
/// reports as `resource-id` — so `android_ui` prints it and `android_tap`'s id
/// target matches on it, exactly as it does for a classic View app. The
/// identifiers mirror the Java example (`tvName1` / `tvStatus1` / `btnDone1` …),
/// so the two apps can be driven by the same selectors.
///
/// One Flutter-specific detail decides whether those identifiers are *readable*:
/// a `Text` does not create its own semantics node, so its label lands on the
/// nearest enclosing node — which is the one carrying the identifier. That is why
/// the text rows below need no explicit `label`. Buttons **do** create a node of
/// their own, so they get an explicit `label` and `excludeSemantics: true`, or
/// the label would sit on a child and the identified node would read as empty.
class DutyPage extends StatefulWidget {
  const DutyPage({super.key});

  @override
  State<DutyPage> createState() => _DutyPageState();
}

class _DutyPageState extends State<DutyPage> {
  final DutyStore _store = DutyStore();
  final TextEditingController _members = TextEditingController(text: 'zhangsan, lisi, wangwu, zhaoliu');
  final TextEditingController _billTotal = TextEditingController(text: '12800');

  List<DutyEntry> _entries = const [];
  String _billResult = '未计算';
  String _storePath = '(解析中)';
  bool _restored = false;

  @override
  void initState() {
    super.initState();
    _restore();
  }

  @override
  void dispose() {
    _members.dispose();
    _billTotal.dispose();
    super.dispose();
  }

  Future<void> _restore() async {
    final entries = await _store.load();
    final target = await _store.file();
    if (!mounted) return;
    setState(() {
      _entries = entries;
      _storePath = target.path;
      _restored = true;
    });
  }

  List<String> get _memberList => _members.text
      .split(',')
      .map((name) => name.trim())
      .where((name) => name.isNotEmpty)
      .toList();

  Future<void> _generate() async {
    final roster = buildRoster(_memberList);
    final saved = await _store.save(roster);
    if (!mounted) return;
    setState(() => _entries = roster);
    _tell(
      !saved
          ? '值日表已生成，但保存失败：${_store.lastError}'
          : roster.isEmpty
              ? '名单为空，没有生成值日表'
              : '已生成 ${roster.length} 天值日表',
    );
  }

  Future<void> _toggle(int index) async {
    final next = [..._entries];
    final current = next[index];
    next[index] = DutyEntry(day: current.day, name: current.name, done: !current.done);
    final saved = await _store.save(next);
    if (!mounted) return;
    setState(() => _entries = next);
    if (!saved) _tell('状态已更新，但保存失败：${_store.lastError}');
  }

  Future<void> _clear() async {
    await _store.clear();
    if (!mounted) return;
    setState(() {
      _entries = const [];
      _billResult = '未计算';
    });
    _tell('已清空值日表');
  }

  Future<void> _remind() async {
    final pending = _entries.where((entry) => !entry.done).map((entry) => entry.name).toList();
    final body = pending.isEmpty ? '今天的值日都完成了' : '还没完成：${pending.take(3).join('、')}';
    final channel = await postReminder(title: '宿舍值日提醒', body: body);
    if (!mounted) return;
    _tell('已发送提醒（渠道 $channel）');
  }

  /// Deliberately unguarded: an empty roster divides by zero. Dart reports the
  /// error through the zone guard, so the process survives — which is why the
  /// Flutter crash test asserts a *localised Dart stack*, not a dead pid the way
  /// the Java one does.
  void _splitBill() {
    final totalCents = int.tryParse(_billTotal.text.trim()) ?? 0;
    final each = splitBill(totalCents, _entries.length);
    setState(() => _billResult = '每人 ¥${(each / 100).toStringAsFixed(2)}');
  }

  void _raisedError() => triggerValidationCrash();

  void _tell(String message) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), behavior: SnackBarBehavior.floating),
    );
  }

  @override
  Widget build(BuildContext context) {
    final done = doneCount(_entries);
    return Scaffold(
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 132),
          children: [
            _header(context, done),
            const SizedBox(height: 20),
            _memberField(context),
            const SizedBox(height: 22),
            if (_entries.isEmpty)
              _emptyState(context)
            else
              for (var i = 0; i < _entries.length; i++) ...[
                _rosterRow(context, i, _entries[i]),
                const SizedBox(height: 12),
              ],
            const SizedBox(height: 10),
            _verificationPanel(context),
            const SizedBox(height: 8),
            if (!_restored)
              Text(
                '正在读取本地值日表…',
                style: Theme.of(context).textTheme.bodySmall,
                textAlign: TextAlign.center,
              ),
          ],
        ),
      ),
      floatingActionButton: _identified(
        'btnGenerate',
        label: '生成值日表',
        button: true,
        child: FloatingActionButton.extended(
          onPressed: _generate,
          icon: const Icon(Icons.auto_awesome_rounded),
          label: const Text('生成值日表'),
        ),
      ),
    );
  }

  // ── surfaces ──────────────────────────────────────────────────────────────

  Widget _header(BuildContext context, int done) {
    final scheme = Theme.of(context).colorScheme;
    final total = _entries.length;
    final ratio = total == 0 ? 0.0 : done / total;
    return Container(
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(radius),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [scheme.primary, Color.lerp(scheme.primary, scheme.tertiary, 0.55)!],
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.cleaning_services_rounded, size: 20, color: scheme.onPrimary),
              const SizedBox(width: 8),
              Text(
                '宿舍值日',
                style: Theme.of(context)
                    .textTheme
                    .titleMedium
                    ?.copyWith(color: scheme.onPrimary, fontWeight: FontWeight.w600),
              ),
              const Spacer(),
              Semantics(
                identifier: 'tvToday',
                child: Text(
                  _today(),
                  style: Theme.of(context).textTheme.labelLarge?.copyWith(
                        color: scheme.onPrimary.withAlpha(215),
                      ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 18),
          Row(
            crossAxisAlignment: CrossAxisAlignment.baseline,
            textBaseline: TextBaseline.alphabetic,
            children: [
              Semantics(
                identifier: 'tvProgress',
                child: Text(
                  '$done / $total',
                  style: Theme.of(context).textTheme.displaySmall?.copyWith(
                        color: scheme.onPrimary,
                        fontWeight: FontWeight.w700,
                      ),
                ),
              ),
              const SizedBox(width: 8),
              Text(
                '天已完成',
                style: Theme.of(context)
                    .textTheme
                    .bodyMedium
                    ?.copyWith(color: scheme.onPrimary.withAlpha(215)),
              ),
            ],
          ),
          const SizedBox(height: 14),
          ClipRRect(
            borderRadius: BorderRadius.circular(6),
            child: LinearProgressIndicator(
              value: ratio,
              minHeight: 6,
              backgroundColor: scheme.onPrimary.withAlpha(60),
              valueColor: AlwaysStoppedAnimation<Color>(scheme.onPrimary),
            ),
          ),
        ],
      ),
    );
  }

  Widget _memberField(BuildContext context) {
    // No `excludeSemantics` here: the field's own node carries the editable
    // state and the entered text, which is what makes it usable rather than just
    // addressable.
    return Semantics(
      identifier: 'tfMembers',
      textField: true,
      label: '宿舍成员',
      child: TextField(
        controller: _members,
        decoration: InputDecoration(
          labelText: '宿舍成员（逗号分隔）',
          hintText: 'zhangsan, lisi, wangwu, zhaoliu',
          prefixIcon: const Icon(Icons.group_outlined),
          filled: true,
          fillColor: Theme.of(context).colorScheme.surface,
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(14),
            borderSide: BorderSide.none,
          ),
        ),
      ),
    );
  }

  Widget _emptyState(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 38),
      decoration: surfaceDecoration(context),
      child: Column(
        children: [
          Icon(Icons.event_note_rounded, size: 46, color: scheme.outline),
          const SizedBox(height: 14),
          Semantics(
            identifier: 'tvEmpty',
            child: Text('还没有值日表', style: Theme.of(context).textTheme.titleMedium),
          ),
          const SizedBox(height: 6),
          Text(
            '填好成员名单，点右下角生成',
            style: Theme.of(context)
                .textTheme
                .bodySmall
                ?.copyWith(color: scheme.onSurfaceVariant),
          ),
        ],
      ),
    );
  }

  Widget _rosterRow(BuildContext context, int index, DutyEntry entry) {
    final scheme = Theme.of(context).colorScheme;
    final number = index + 1;
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 14, 14, 14),
      decoration: surfaceDecoration(context),
      child: Row(
        children: [
          Container(
            width: 44,
            height: 44,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: entry.done ? scheme.primary.withAlpha(30) : scheme.surfaceContainerHighest,
            ),
            child: Text(
              entry.name.isEmpty ? '?' : entry.name.substring(0, 1).toUpperCase(),
              style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    color: entry.done ? scheme.primary : scheme.onSurfaceVariant,
                    fontWeight: FontWeight.w700,
                  ),
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Text(
                      entry.day,
                      style: Theme.of(context)
                          .textTheme
                          .labelMedium
                          ?.copyWith(color: scheme.onSurfaceVariant),
                    ),
                    const SizedBox(width: 10),
                    Semantics(
                      identifier: 'tvName$number',
                      child: Text(
                        entry.name,
                        style: Theme.of(context)
                            .textTheme
                            .titleSmall
                            ?.copyWith(fontWeight: FontWeight.w600),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                Semantics(
                  identifier: 'tvStatus$number',
                  child: Text(
                    entry.done ? '已完成' : '未完成',
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: entry.done ? scheme.primary : scheme.onSurfaceVariant,
                          fontWeight: entry.done ? FontWeight.w600 : FontWeight.w400,
                        ),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 10),
          _identified(
            'btnDone$number',
            label: entry.done ? '撤销完成' : '完成',
            button: true,
            child: entry.done
                ? OutlinedButton(onPressed: () => _toggle(index), child: const Text('撤销完成'))
                : FilledButton.tonal(onPressed: () => _toggle(index), child: const Text('完成')),
          ),
        ],
      ),
    );
  }

  Widget _verificationPanel(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      decoration: surfaceDecoration(context),
      clipBehavior: Clip.antiAlias,
      child: Theme(
        data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
        // No identifier on the tile itself: `excludeSemantics` would hide the
        // controls inside it, and without it the identified node would be the
        // whole panel rather than its header row. `tap-text "验证用"` reaches the
        // header, which is what the live test does.
        child: ExpansionTile(
          leading: Icon(Icons.science_outlined, color: scheme.onSurfaceVariant),
          title: Text('验证用', style: Theme.of(context).textTheme.titleSmall),
          subtitle: Text(
            '提醒、账单分摊与一次真实的越界异常',
            style: Theme.of(context).textTheme.bodySmall?.copyWith(color: scheme.onSurfaceVariant),
          ),
          childrenPadding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          children: [
            Row(
              children: [
                Expanded(
                  child: Semantics(
                    identifier: 'tfBillTotal',
                    textField: true,
                    label: '账单总额',
                    child: TextField(
                      controller: _billTotal,
                      keyboardType: TextInputType.number,
                      decoration: const InputDecoration(
                        labelText: '账单总额（分）',
                        isDense: true,
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                _identified(
                  'btnSplitBill',
                  label: '分摊账单',
                  button: true,
                  child: FilledButton.tonal(onPressed: _splitBill, child: const Text('分摊账单')),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Align(
              alignment: Alignment.centerLeft,
              child: Semantics(
                identifier: 'tvResult',
                child: Text(
                  _billResult,
                  style: Theme.of(context)
                      .textTheme
                      .titleSmall
                      ?.copyWith(fontWeight: FontWeight.w600),
                ),
              ),
            ),
            const SizedBox(height: 6),
            // The path the roster is actually written to. Showing it is not
            // decoration: the first version of this store wrote to a temp
            // directory outside the sandbox and failed silently, and there was no
            // way to see that from the screen.
            Align(
              alignment: Alignment.centerLeft,
              child: Semantics(
                identifier: 'tvStorePath',
                child: Text(
                  _storePath,
                  style: Theme.of(context)
                      .textTheme
                      .bodySmall
                      ?.copyWith(color: scheme.onSurfaceVariant),
                ),
              ),
            ),
            const SizedBox(height: 14),
            Wrap(
              spacing: 10,
              runSpacing: 10,
              children: [
                _identified(
                  'btnNotify',
                  label: '发送提醒',
                  button: true,
                  child: OutlinedButton.icon(
                    onPressed: _remind,
                    icon: const Icon(Icons.notifications_active_outlined, size: 18),
                    label: const Text('发送提醒'),
                  ),
                ),
                _identified(
                  'btnClear',
                  label: '清空值日表',
                  button: true,
                  child: OutlinedButton.icon(
                    onPressed: _clear,
                    icon: const Icon(Icons.delete_outline, size: 18),
                    label: const Text('清空值日表'),
                  ),
                ),
                _identified(
                  'btnTestCrash',
                  label: '触发一个异常',
                  button: true,
                  child: OutlinedButton.icon(
                    onPressed: _raisedError,
                    icon: const Icon(Icons.warning_amber_rounded, size: 18),
                    label: const Text('触发一个异常'),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  /// Wrap a control that builds its own semantics node.
  ///
  /// A button creates a node of its own, so an identifier on the enclosing
  /// `Semantics` would sit on a node whose label is empty. `excludeSemantics`
  /// drops the child's node and `label` puts the text back on the identified one,
  /// which is what makes `resource-id` and `text` land on the *same* node — the
  /// shape `android_ui` prints and `android_tap` matches.
  static Widget _identified(
    String identifier, {
    required String label,
    required Widget child,
    bool button = false,
  }) {
    return Semantics(
      identifier: identifier,
      label: label,
      button: button,
      excludeSemantics: true,
      child: child,
    );
  }

  static String _today() {
    const names = ['一', '二', '三', '四', '五', '六', '日'];
    final now = DateTime.now();
    final month = now.month.toString().padLeft(2, '0');
    final day = now.day.toString().padLeft(2, '0');
    return '$month-$day 周${names[now.weekday - 1]}';
  }
}
