/**
 * Cordis plugin: registers the android_* tools into the harness `tools`
 * registry.
 *
 * Shipped as a dsh bundle.  `cordis.patch.yml` — declared by package.json as
 * `dsh.bundle.patch` — inserts the row that loads this module, so installing the
 * package into a profile is the whole setup:
 *
 *   dsh plugin install dsh-android-develop-helper
 *
 * Mounting a source checkout directly also works, since a composition row may
 * point at a file by URL:
 *
 *   - id: android-develop-helper
 *     name: 'file:///E:/code/dsh-android-develop-helper/src/plugin.js'
 *     config:
 *       timeoutMs: 300000
 *       flags:
 *         emulatorType: mumu
 *         adbPort: 16384
 *
 * The module deliberately has **no bare imports** — only relative paths and
 * `node:`-prefixed builtins.  A composition row is loaded by URL, and Node
 * resolves bare specifiers from the importing file's location, which is outside
 * the profile's `node_modules` when the row points at a source checkout.  Keeping
 * the imports relative means the row works from wherever the plugin lives, and it
 * is also why this package declares **no peer dependency on the harness**: with
 * nothing to resolve, there is no version range that can turn the bundle into
 * `incompatible-version` when the harness moves.
 */
import { AndroidSession } from './manager.js'
import { createTools } from './tools.js'

/** Stable loader identity. */
export const name = 'dsh-android-develop-helper'

/** The tool registry must exist before the tools can be contributed. */
export const inject = ['tools']

/** Per-tool default timeout: installs and UI dumps are legitimately slow. */
const DEFAULT_TIMEOUT_MS = 300000

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ timeoutMs?: number, flags?: object, cwd?: string }} [config]
 */
export function apply(ctx, config = {}) {
  const timeoutMs = Number.isFinite(config?.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS
  const cwd = config?.cwd ?? process.cwd()

  // `cwd` decides where run artifacts go when nothing more explicit is set.  As
  // an installed bundle this module lives inside the profile's `node_modules`,
  // so the package directory is the wrong place to accumulate screenshots and
  // adb logs — they would sit in an installed dependency and be erased by the
  // next install.  An explicit `artifactsDir` in `flags` still wins.
  const session = new AndroidSession({ ...(config?.flags ?? {}), cwd, echoCommands: false })

  for (const definition of createTools({ session, cwd })) {
    ctx.tools.register({
      ...definition,
      timeoutMs,
      async execute(args, exec) {
        // A cancelled turn must not leave a half-finished device operation
        // blocking the next call.
        exec?.signal?.throwIfAborted?.()
        return definition.execute(args, exec)
      },
    })
  }

  // Dropping the row must also drop the cached adb connection and its artifact
  // stream; a leaked child process would outlive the composition.
  ctx.effect(() => () => {
    void session.reset()
  })
}

export { createTools, AndroidSession }
