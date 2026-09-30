/**
 * Application lifecycle: install, launch, inspect, stop, uninstall.
 *
 * The one non-obvious rule here: `adb install` exits 0 in situations where the
 * app was not actually replaced (a stale package, an ignored `-r`, a partial
 * write).  "Installed successfully" is therefore treated as a claim to verify,
 * not a result: after install we resolve `pm path`, hash the on-device APK and
 * compare it with the local artifact.  The hash never crosses the wire — only
 * the 64-character digest does — so verification is cheap even for a 40 MB APK.
 */
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { apkPackageName as readApkPackageName } from './apk.js'

export class AppError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'AppError'
    Object.assign(this, details)
  }
}

/**
 * Which activity is on screen right now.
 *
 * Android has moved this string around across releases (`mFocusedActivity`,
 * `mResumedActivity`, `topResumedActivity`), and OEM builds differ, so several
 * sources are tried in order of reliability.
 */
export async function currentActivity(adb) {
  const attempts = [
    { source: 'dumpsys activity activities', command: "dumpsys activity activities | grep -m2 -E 'topResumedActivity|ResumedActivity'" },
    { source: 'dumpsys window', command: "dumpsys window 2>/dev/null | grep -m2 -E 'mCurrentFocus|mFocusedApp'" },
    { source: 'dumpsys activity top', command: 'dumpsys activity top | grep -m1 ACTIVITY' },
  ]
  for (const attempt of attempts) {
    const { text } = await adb.shellLoose(attempt.command, { timeoutMs: 15000 })
    if (!text) continue
    const parsed = parseActivityLine(text)
    if (parsed) return { ...parsed, source: attempt.source, raw: text.split('\n')[0].trim() }
  }
  return { package: null, activity: null, component: null, source: null, raw: null }
}

function parseActivityLine(text) {
  const componentRe = /([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/g
  let match
  const found = []
  while ((match = componentRe.exec(text)) !== null) found.push({ package: match[1], activity: match[2] })
  const useful = found.find((c) => !/^com\.android\.server/.test(c.package) && !/^android$/.test(c.package))
  const chosen = useful ?? found[0]
  if (!chosen) return null
  const activity = chosen.activity.startsWith('.') ? `${chosen.package}${chosen.activity}` : chosen.activity
  const full = activity.includes('.') ? activity : `${chosen.package}.${activity}`
  return { package: chosen.package, activity: full, component: `${chosen.package}/${full}` }
}

/** `dumpsys package <pkg>` summary. */
export async function packageInfo(adb, pkg) {
  if (!pkg) throw new AppError('packageInfo 需要包名')
  const { text, code } = await adb.shellLoose(`dumpsys package ${pkg}`, { timeoutMs: 20000 })
  if (!text || /Unable to find package/i.test(text)) {
    return { package: pkg, installed: false, code }
  }
  const grab = (re) => re.exec(text)?.[1]?.trim() ?? null
  const pathLine = /codePath=(\S+)/.exec(text)?.[1] ?? null
  const apkPath = await adb.shellLoose(`pm path ${pkg}`, { timeoutMs: 8000 })
  return {
    package: pkg,
    installed: true,
    versionName: grab(/versionName=(\S+)/),
    versionCode: grab(/versionCode=(\d+)/),
    minSdk: grab(/minSdk=(\d+)/),
    targetSdk: grab(/targetSdk=(\d+)/),
    firstInstallTime: grab(/firstInstallTime=(.+)/),
    lastUpdateTime: grab(/lastUpdateTime=(.+)/),
    dataDir: grab(/dataDir=(\S+)/),
    codePath: pathLine,
    apkPaths: (apkPath.text ?? '')
      .split('\n')
      .map((l) => l.replace(/^package:/, '').trim())
      .filter(Boolean),
    enabled: !/enabled=false/.test(text),
    debug: /DEBUGGABLE/.test(text),
  }
}

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function safeApkPackage(apkPath) {
  try {
    return readApkPackageName(apkPath)
  } catch {
    return null
  }
}

/** Hash an on-device file, returning null when no hashing tool exists. */
export async function deviceFileHash(adb, remotePath, algorithm = 'sha256') {
  const tool = algorithm === 'md5' ? 'md5sum' : 'sha256sum'
  const { text, code } = await adb.shellLoose(`${tool} ${shellQuote(remotePath)}`, { timeoutMs: 120000 })
  if (code !== 0) return null
  const match = /^([0-9a-fA-F]{16,64})\s/.exec(text.trim())
  return match ? match[1].toLowerCase() : null
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Decide whether an `adb install` actually replaced the package.
 *
 * This is subtler than checking the exit code.  On Android 13+ a streamed
 * install prints, in order:
 *
 *   Performing Incremental Install
 *   Performing Streamed Install
 *   Success: streamed 37341 bytes
 *   Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: … signatures do not match …]
 *
 * — and **exits 0**.  The `Success:` line describes the byte stream, not the
 * package commit, so a naive `/Success/` test reports a successful install for a
 * package that was never replaced.  The authoritative signals are the absence of
 * a `Failure [REASON]` and a zero exit code.
 *
 * @returns {{success:boolean, failure:string|null, reason:string|null}}
 */
export function classifyInstallOutput(text, code = 0) {
  // `Failure [CODE: human readable detail]` — only the code is stable, and the
  // detail is a sentence that varies by release.
  const failure = /Failure\s*\[([A-Z_0-9]+)/.exec(text)
  if (failure) {
    const reason = failure[1]
    return {
      success: false,
      failure: reason,
      reason: explainInstallFailure(reason) ?? `安装被拒绝：${reason}`,
    }
  }
  if (code !== 0) {
    return { success: false, failure: `exit ${code}`, reason: text.trim() || `adb install 退出码 ${code}` }
  }
  if (!/Success/i.test(text)) {
    return { success: false, failure: 'no-success-marker', reason: text.trim() || 'adb install 没有报告 Success' }
  }
  return { success: true, failure: null, reason: null }
}

/** Turn a PackageManager failure code into a next step. */
function explainInstallFailure(code) {
  const table = {
    INSTALL_FAILED_UPDATE_INCOMPATIBLE:
      '设备上已安装的包与新 APK 签名不一致（通常是用不同密钥重新构建过）。' +
      '先 `uninstall` 再安装，或固定使用同一个签名密钥。',
    INSTALL_FAILED_VERSION_DOWNGRADE: '版本号低于已安装版本。加 --downgrade 或提高 versionCode。',
    INSTALL_FAILED_ALREADY_EXISTS: '包已存在且未加 -r。',
    INSTALL_FAILED_INSUFFICIENT_STORAGE: '设备存储不足。',
    INSTALL_FAILED_INVALID_APK: 'APK 结构损坏。',
    INSTALL_PARSE_FAILED_NO_CERTIFICATES: 'APK 未签名。',
    INSTALL_FAILED_USER_RESTRICTED: '设备禁止安装（可能关闭了「USB 安装」）。',
    INSTALL_FAILED_TEST_ONLY: 'APK 标记为 test-only。加 -t 或去掉 manifest 中的 testOnly。',
  }
  return table[code] ?? null
}

/**
 * Install an APK and, by default, prove it landed.
 *
 * @param {object} options
 * @param {boolean} [options.reinstall=true]      `-r`
 * @param {boolean} [options.grantPermissions=true] `-g`
 * @param {boolean} [options.allowDowngrade=false] `-d`
 * @param {boolean} [options.allowTestPackages=true] `-t`
 * @param {boolean} [options.verify=true]         hash-compare after install
 * @param {string}  [options.expectSha]           caller-supplied expected digest
 */
export async function install(adb, apkPath, options = {}) {
  const {
    reinstall = true,
    grantPermissions = true,
    allowDowngrade = false,
    allowTestPackages = true,
    verify = true,
    expectSha = null,
    timeoutMs = 300000,
  } = options

  if (!fs.existsSync(apkPath)) throw new AppError(`APK 不存在: ${apkPath}`)
  const args = ['install']
  if (reinstall) args.push('-r')
  if (grantPermissions) args.push('-g')
  if (allowDowngrade) args.push('-d')
  if (allowTestPackages) args.push('-t')
  args.push(apkPath)

  const result = await adb.exec(args, { timeoutMs, check: false })
  const stdout = result.stdout.toString('utf8').trim()
  const stderr = result.stderr.toString('utf8').trim()
  const combined = `${stdout}\n${stderr}`
  const verdict = classifyInstallOutput(combined, result.code)

  const report = {
    apk: apkPath,
    sizeBytes: fs.statSync(apkPath).size,
    success: verdict.success,
    failure: verdict.failure,
    code: result.code,
    output: combined.trim(),
    verified: null,
    expectedSha: expectSha,
    deviceSha: null,
    package: safeApkPackage(apkPath),
  }
  if (!verdict.success) {
    throw new AppError(
      `安装失败${verdict.failure ? ` [${verdict.failure}]` : ''}: ${verdict.reason ?? report.output}`,
      { ...report, hint: verdict.reason && verdict.reason !== report.output ? verdict.reason : null },
    )
  }

  if (verify) {
    const localSha = expectSha ?? sha256File(apkPath)
    report.expectedSha = localSha
    if (!report.package) {
      report.verified = false
      report.verifyNote = '无法确定包名（缺少 aapt/apkanalyzer），跳过校验'
      return report
    }
    const info = await packageInfo(adb, report.package)
    const remote = info.apkPaths?.[0]
    if (!remote) {
      report.verified = false
      report.verifyNote = `安装后 pm path ${report.package} 为空`
      return report
    }
    const deviceSha = await deviceFileHash(adb, remote, 'sha256')
    report.deviceSha = deviceSha
    report.remoteApk = remote
    if (deviceSha === null) {
      report.verified = null
      report.verifyNote = '设备上缺少 sha256sum，无法比对（不视为失败）'
    } else {
      report.verified = deviceSha === localSha
      if (!report.verified) {
        throw new AppError(
          `安装校验失败：设备上的 ${report.package} (${deviceSha.slice(0, 12)}…) 与本地 APK ` +
            `(${localSha.slice(0, 12)}…) 不一致。`,
          report,
        )
      }
    }
  }
  return report
}

/**
 * Package name of a local APK, read from its binary manifest.
 *
 * Deliberately *not* a byte-pattern heuristic: scanning an APK for
 * `com.something.something` returns library class names
 * (`androidx.lifecycle_lifecycle`) as often as the real package, and a wrong
 * package name silently turns the post-install verification into a no-op.
 */
export function apkPackageName(apkPath) {
  return readApkPackageName(apkPath)
}

/**
 * The launcher activity of an installed package.
 * `cmd package resolve-activity` is the authoritative answer and works on
 * API 24+, which is well below anything shipped today.
 */
export async function launcherActivity(adb, pkg) {
  const { text } = await adb.shellLoose(
    `cmd package resolve-activity --brief ${pkg} 2>/dev/null | tail -n 1`,
    { timeoutMs: 15000 },
  )
  const component = text.trim()
  if (component && component.includes('/')) return component
  return null
}

export async function uninstall(adb, pkg, { keepData = false } = {}) {
  const args = ['uninstall']
  if (keepData) args.push('-k')
  args.push(pkg)
  const result = await adb.exec(args, { timeoutMs: 60000, check: false })
  const output = `${result.stdout.toString('utf8')}${result.stderr.toString('utf8')}`.trim()
  return { package: pkg, success: /Success/i.test(output), output, code: result.code }
}

/**
 * Launch an app.
 * With a component: `am start -W`.  With only a package: resolve the launcher
 * activity through `monkey`, which is the only reliable version-independent way.
 */
export async function start(adb, target, options = {}) {
  const { extras = {}, data = null, action = null, category = null, wait = true, forceStop = false } = options
  if (forceStop) {
    const pkg = target.split('/')[0]
    await adb.shellLoose(`am force-stop ${pkg}`, { timeoutMs: 10000 })
  }

  const hasComponent = target.includes('/')
  let component = hasComponent ? target : null
  let resolvedVia = hasComponent ? 'explicit' : null
  if (!component) {
    component = await launcherActivity(adb, target)
    resolvedVia = component ? 'cmd package resolve-activity' : null
  }
  if (!component) {
    const monkey = await adb.shellLoose(
      `monkey -p ${target} -c android.intent.category.LAUNCHER 1`,
      { timeoutMs: 60000 },
    )
    return {
      target,
      component: null,
      resolvedVia: 'monkey',
      success: !/No activities found|aborted|Error/i.test(monkey.text),
      method: 'monkey',
      output: monkey.text.trim(),
    }
  }

  const args = ['am', 'start']
  if (wait) args.push('-W')
  if (action) args.push('-a', action)
  if (category) args.push('-c', category)
  if (data) args.push('-d', data)
  for (const [key, value] of Object.entries(extras)) {
    if (typeof value === 'boolean') args.push('--ez', key, String(value))
    else if (Number.isInteger(value)) args.push('--ei', key, String(value))
    else args.push('--es', key, String(value))
  }
  args.push('-n', component)

  const command = args.map(shellQuote).join(' ')
  const { text, stderr, code } = await adb.shellLoose(command, { timeoutMs: 60000 })
  const success = code === 0 && !/Error:|Exception|does not exist/i.test(`${text}${stderr}`)
  const activity = await currentActivity(adb).catch(() => null)
  return {
    target,
    component,
    resolvedVia,
    success,
    method: 'am start',
    output: `${text}\n${stderr}`.trim(),
    current: success ? activity : null,
  }
}

export async function stop(adb, pkg) {
  const { text, code } = await adb.shellLoose(`am force-stop ${pkg}`, { timeoutMs: 15000 })
  return { package: pkg, success: code === 0, output: text }
}

export async function clearData(adb, pkg) {
  const { text } = await adb.shellLoose(`pm clear ${pkg}`, { timeoutMs: 30000 })
  return { package: pkg, success: /Success/i.test(text), output: text }
}

export async function listPackages(adb, { thirdPartyOnly = true, filter = null } = {}) {
  const flag = thirdPartyOnly ? '-3' : ''
  const { text } = await adb.shellLoose(`pm list packages ${flag}`.trim(), { timeoutMs: 20000 })
  let packages = text
    .split('\n')
    .map((line) => line.replace(/^package:/, '').trim())
    .filter(Boolean)
  if (filter) packages = packages.filter((p) => p.includes(filter))
  return packages.sort()
}

export async function pidOf(adb, pkg) {
  const { text } = await adb.shellLoose(`pidof ${pkg}`, { timeoutMs: 8000 })
  const pid = Number.parseInt(text.trim().split(/\s+/)[0] ?? '', 10)
  return Number.isFinite(pid) ? pid : null
}

/**
 * Grant every runtime permission the package declares.
 *
 * `adb install -g` grants them once, but `pm clear` revokes them again — which
 * is easy to miss because the app then starts and silently cannot notify.  The
 * list comes from `dumpsys package`, so it covers whatever the app actually
 * requests rather than a hard-coded set.
 *
 * @returns {{package:string, granted:string[], failed:Array<{permission:string,error:string}>}}
 */
export async function grantRuntimePermissions(adb, pkg) {
  if (!pkg) throw new AppError('grantRuntimePermissions 需要包名')
  const { text } = await adb.shellLoose(`dumpsys package ${pkg}`, { timeoutMs: 25000 })
  const pending = new Set()
  const re = /(android\.permission\.[A-Z_0-9]+):\s*granted=(true|false)/g
  let match
  while ((match = re.exec(text)) !== null) {
    if (match[2] === 'false') pending.add(match[1])
  }

  const granted = []
  const failed = []
  for (const permission of pending) {
    const result = await adb.shellLoose(`pm grant ${pkg} ${permission}`, { timeoutMs: 15000 })
    if (result.code === 0 && !/Exception|Error|not a changeable/i.test(result.text)) {
      granted.push(permission)
    } else {
      failed.push({ permission, error: result.text.trim() || result.stderr.trim() })
    }
  }
  return { package: pkg, granted, failed, requested: [...pending] }
}

export async function isRunning(adb, pkg) {
  return (await pidOf(adb, pkg)) !== null
}

/** Logcat, screenshots and dumps live under one directory per app. */
export async function crashEvidence(adb, pkg) {
  const activity = await currentActivity(adb).catch(() => null)
  const pid = await pidOf(adb, pkg).catch(() => null)
  const info = await packageInfo(adb, pkg).catch(() => null)
  return { activity, pid, info }
}
