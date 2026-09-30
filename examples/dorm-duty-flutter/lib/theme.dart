import 'package:flutter/material.dart';

/// One accent seed, a near-white canvas, and rounded surfaces.
///
/// The look is borrowed from the products this sits next to rather than invented:
/// a task list (TickTick / Google Tasks) for the single-column card rows, and a
/// weekly roster board for the way a day, a name and a state sit on one line.
///
/// Theme wiring is kept thin on purpose — surfaces are decorated at the widget
/// level, so the example does not depend on `CardThemeData`-era API details.
const Color seed = Color(0xFF4C6FFF);
const Color canvas = Color(0xFFF4F6FB);

/// Corner radius shared by every surface, so the app reads as one system.
const double radius = 18;

ThemeData buildTheme(Brightness brightness) {
  final scheme = ColorScheme.fromSeed(seedColor: seed, brightness: brightness);
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    scaffoldBackgroundColor: brightness == Brightness.light ? canvas : scheme.surface,
    splashFactory: InkSparkle.splashFactory,
  );
}

/// The raised surface every card in this app sits on.
BoxDecoration surfaceDecoration(BuildContext context, {Color? tint}) {
  final scheme = Theme.of(context).colorScheme;
  return BoxDecoration(
    color: tint ?? scheme.surface,
    borderRadius: BorderRadius.circular(radius),
    border: Border.all(color: scheme.outlineVariant.withAlpha(90)),
    boxShadow: [
      BoxShadow(
        color: scheme.shadow.withAlpha(12),
        blurRadius: 18,
        offset: const Offset(0, 6),
      ),
    ],
  );
}
