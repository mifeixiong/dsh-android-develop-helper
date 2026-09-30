/**
 * Input: touch, gestures, text and hardware keys.
 *
 * Every adb `input` invocation costs a full round trip (~40-60 ms locally, far
 * more over a real USB link), so anything that needs a sequence is issued as a
 * single `adb shell` batch.  Text entry additionally has to survive two shells
 * (the host's and the device's) and Android's own `input` escaping, which is
 * why `inputText` builds the command byte-for-byte instead of interpolating.
 */

export const KEYCODES = {
  home: 3,
  back: 4,
  call: 5,
  endcall: 6,
  up: 19,
  down: 20,
  left: 21,
  right: 22,
  center: 23,
  volume_up: 24,
  volume_down: 25,
  power: 26,
  camera: 27,
  clear: 28,
  a: 29,
  enter: 66,
  del: 67,
  delete: 67,
  backspace: 67,
  menu: 82,
  search: 84,
  play_pause: 85,
  stop: 86,
  next: 87,
  previous: 88,
  mute: 91,
  page_up: 92,
  page_down: 93,
  escape: 111,
  forward_del: 112,
  move_home: 122,
  move_end: 123,
  tab: 61,
  space: 62,
  app_switch: 187,
  recents: 187,
  cut: 277,
  copy: 278,
  paste: 279,
  wakeup: 224,
  sleep_key: 223,
}

export class InputError extends Error {
  constructor(message, details = {}) {
    super(message)
    this.name = 'InputError'
    Object.assign(this, details)
  }
}

/** Resolve `"home"`, `"KEYCODE_HOME"`, `"3"` or `3` to a numeric keycode. */
export function resolveKeycode(key) {
  if (typeof key === 'number' && Number.isInteger(key)) return key
  const text = String(key).trim()
  if (/^\d+$/.test(text)) return Number.parseInt(text, 10)
  const normalized = text.toLowerCase().replace(/^keycode_/, '')
  if (KEYCODES[normalized] !== undefined) return KEYCODES[normalized]
  throw new InputError(`未知按键: ${key}（可用: ${Object.keys(KEYCODES).join(', ')}）`)
}

/** `adb shell input tap x y`. */
export async function tap(adb, x, y, options = {}) {
  const command = `input tap ${Math.round(x)} ${Math.round(y)}`
  await adb.shell(command, { timeoutMs: options.timeoutMs ?? 15000 })
  return { x: Math.round(x), y: Math.round(y) }
}

/** Long press via `input swipe` with identical endpoints and a long duration. */
export async function longPress(adb, x, y, durationMs = 800, options = {}) {
  const command = `input swipe ${Math.round(x)} ${Math.round(y)} ${Math.round(x)} ${Math.round(y)} ${Math.round(durationMs)}`
  await adb.shell(command, { timeoutMs: options.timeoutMs ?? 20000 })
  return { x: Math.round(x), y: Math.round(y), durationMs }
}

export async function swipe(adb, from, to, options = {}) {
  const duration = Math.round(options.durationMs ?? 300)
  const command = `input swipe ${Math.round(from.x)} ${Math.round(from.y)} ${Math.round(to.x)} ${Math.round(to.y)} ${duration}`
  await adb.shell(command, { timeoutMs: options.timeoutMs ?? 20000 })
  return { from, to, durationMs: duration }
}

/**
 * Directional scroll.
 *
 * `direction` says *where the content moves*, matching the way a person
 * describes it ("scroll down" reveals lower content), and we translate that to
 * the finger movement that produces it.
 */
export async function scroll(adb, direction, options = {}) {
  const {
    screen = { width: 720, height: 1280 },
    distance = null,
    durationMs = 320,
    anchor = null,
  } = options
  const cx = anchor?.x ?? Math.round(screen.width / 2)
  const cy = anchor?.y ?? Math.round(screen.height / 2)
  const vertical = distance ?? Math.round(Math.min(screen.height, screen.width) * 0.45)
  const horizontal = distance ?? Math.round(Math.min(screen.height, screen.width) * 0.45)

  const vectors = {
    down: { from: { x: cx, y: cy + vertical / 2 }, to: { x: cx, y: cy - vertical / 2 } },
    up: { from: { x: cx, y: cy - vertical / 2 }, to: { x: cx, y: cy + vertical / 2 } },
    right: { from: { x: cx - horizontal / 2, y: cy }, to: { x: cx + horizontal / 2, y: cy } },
    left: { from: { x: cx + horizontal / 2, y: cy }, to: { x: cx - horizontal / 2, y: cy } },
  }
  const vector = vectors[String(direction).toLowerCase()]
  if (!vector) throw new InputError(`未知滚动方向: ${direction}（可用: up/down/left/right）`)
  const clamp = (p) => ({
    x: Math.max(1, Math.min(screen.width - 2, Math.round(p.x))),
    y: Math.max(1, Math.min(screen.height - 2, Math.round(p.y))),
  })
  return swipe(adb, clamp(vector.from), clamp(vector.to), { durationMs })
}

/** Escape a string for Android's `input text`. */
export function escapeInputText(text) {
  // Order matters: escape the backslash first, then the shell metacharacters.
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/(["'`$&|;<>()*?[\]{}~^!#])/g, '\\$1')
    .replace(/ /g, '%s')
}

/** Wrap a device-shell argument in single quotes. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

const isAsciiPrintable = (text) => /^[\x20-\x7e]*$/.test(text)

/** Is the ADBKeyboard IME available for non-ASCII input? */
export async function hasAdbKeyboard(adb, pkg = 'com.android.adbkeyboard') {
  const { text } = await adb.shellLoose(`pm list packages ${pkg}`, { timeoutMs: 10000 })
  return text.includes(pkg)
}

/**
 * Type text into the focused field.
 *
 * Strategy:
 *   - ASCII  → `input text` with metacharacters escaped and spaces as `%s`;
 *   - non-ASCII → ADBKeyboard broadcast (base64) when the IME is installed,
 *     otherwise `input text` is attempted and flagged, because Android's `input`
 *     silently drops characters it cannot map.
 *
 * @returns {{method:string, characters:number, warning?:string}}
 */
export async function inputText(adb, text, options = {}) {
  const value = String(text)
  if (value.length === 0) return { method: 'noop', characters: 0 }
  const adbKeyboardPackage = options.adbKeyboardPackage ?? 'com.android.adbkeyboard'

  if (isAsciiPrintable(value)) {
    await adb.shell(`input text ${shellQuote(escapeInputText(value))}`, {
      timeoutMs: options.timeoutMs ?? 30000,
    })
    return { method: 'input text', characters: value.length }
  }

  const available = await hasAdbKeyboard(adb, adbKeyboardPackage).catch(() => false)
  if (available) {
    const base64 = Buffer.from(value, 'utf8').toString('base64')
    await adb.shell(
      `am broadcast -a ADB_INPUT_B64 --es msg ${shellQuote(base64)}`,
      { timeoutMs: options.timeoutMs ?? 30000 },
    )
    return { method: 'ADBKeyboard broadcast', characters: value.length }
  }

  // Mixed/Unicode without the IME: send the ASCII runs verbatim and warn about
  // the rest rather than silently producing a different string.
  const asciiOnly = value.replace(/[^\x20-\x7e]/g, '')
  if (asciiOnly.length > 0) {
    await adb.shell(`input text ${shellQuote(escapeInputText(asciiOnly))}`, {
      timeoutMs: options.timeoutMs ?? 30000,
    })
  }
  return {
    method: 'input text (ASCII only)',
    characters: asciiOnly.length,
    warning:
      '文本包含非 ASCII 字符，但设备未安装 ADBKeyboard（com.android.adbkeyboard）；' +
      '已只输入 ASCII 部分。请安装后重试，或改用剪贴板方案。',
  }
}

/** Send one or more hardware keys. */
export async function keyEvent(adb, keys, options = {}) {
  const list = Array.isArray(keys) ? keys : [keys]
  const codes = list.map(resolveKeycode)
  const command = codes.map((code) => `input keyevent ${code}`).join(' ; ')
  await adb.shell(command, { timeoutMs: options.timeoutMs ?? 20000 })
  return { codes }
}

/** Erase the currently focused field by pressing DEL repeatedly. */
export async function clearFocusedText(adb, { maxCharacters = 60 } = {}) {
  await adb.shell(`input keyevent ${KEYCODES.move_end}`, { timeoutMs: 10000 })
  const command = Array.from({ length: maxCharacters }, () => `input keyevent ${KEYCODES.del}`).join(' ; ')
  await adb.shell(command, { timeoutMs: 60000 })
  return { deleted: maxCharacters }
}

/** Replace the content of the focused field. */
export async function setFocusedText(adb, text, options = {}) {
  await clearFocusedText(adb, options)
  return inputText(adb, text, options)
}

/** Send several `input tap` commands in one adb round trip. */
export async function tapSequence(adb, points, options = {}) {
  const delayMs = options.delayMs ?? 120
  const commands = points
    .map((p) => `input tap ${Math.round(p.x)} ${Math.round(p.y)}`)
    .join(` ; sleep ${Math.max(0, delayMs / 1000).toFixed(2)} ; `)
  await adb.shell(commands, { timeoutMs: options.timeoutMs ?? 60000 })
  return { count: points.length }
}
