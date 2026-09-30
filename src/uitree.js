/**
 * UI hierarchy: capture, index, query and *compress*.
 *
 * `uiautomator dump` is the slowest thing this toolkit does (~2s on MuMu, and
 * the cost is the instrumentation start, not the tree size), so the design goal
 * here is: dump as rarely as possible, and when we do dump, hand the model
 * something far smaller than the raw 34 KB of XML.
 *
 * Two ideas do the work:
 *
 *  1. **Caching.**  A dump is reused for `dumpCacheTtlMs` unless the caller asks
 *     for a refresh.  Five lookups in a row cost one dump instead of five.
 *  2. **Indexing.**  `simplify()` assigns every interesting node a small integer
 *     the model can pass back to `tap --node N`, and drops the boilerplate
 *     (`index`, `package`, `checkable`, `focusable`, `drawing-order`, empty
 *     attributes).  A typical screen goes from 34 KB to well under 3 KB while
 *     keeping every actionable element.
 */
import { decodeEntities, parseXml, walk } from './xml.js'

/** Parse `[x1,y1][x2,y2]` into numbers. */
export function parseBounds(text) {
  const match = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(text ?? '')
  if (!match) return null
  const [x1, y1, x2, y2] = match.slice(1).map(Number)
  return { x1, y1, x2, y2, width: x2 - x1, height: y2 - y1, cx: (x1 + x2) >> 1, cy: (y1 + y2) >> 1 }
}

function bool(value) {
  return value === 'true'
}

/** Convert one `<node>` element into a flat, typed record. */
export function toNode(element, { parentIndex = -1, depth = 0, index = 0 } = {}) {
  const a = element.attrs
  return {
    index,
    parentIndex,
    depth,
    text: a.text ?? '',
    resourceId: a['resource-id'] ?? '',
    className: a.class ?? '',
    package: a.package ?? '',
    contentDesc: a['content-desc'] ?? '',
    hint: a.hint ?? '',
    bounds: parseBounds(a.bounds),
    boundsRaw: a.bounds ?? '',
    checkable: bool(a.checkable),
    checked: bool(a.checked),
    clickable: bool(a.clickable),
    enabled: bool(a.enabled),
    focusable: bool(a.focusable),
    focused: bool(a.focused),
    scrollable: bool(a.scrollable),
    longClickable: bool(a['long-clickable']),
    password: bool(a.password),
    selected: bool(a.selected),
  }
}

/** Short resource id: `com.foo:id/bar` → `bar` (keeps the raw id available). */
export function shortId(resourceId) {
  if (!resourceId) return ''
  const slash = resourceId.indexOf('/')
  return slash >= 0 ? resourceId.slice(slash + 1) : resourceId
}

export function parseDump(source) {
  const document = parseXml(source)
  if (!document) throw new Error('uiautomator dump 输出为空或不是合法 XML')
  const rotation = Number.parseInt(document.attrs?.rotation ?? '0', 10) || 0
  return { root: document, rotation }
}

/** Flatten a parsed dump into an array of records (parent links preserved). */
export function flattenDump(document) {
  const nodes = []
  const visit = (element, parentIndex, depth) => {
    const index = nodes.length
    nodes.push(toNode(element, { parentIndex, depth, index }))
    for (const child of element.children ?? []) visit(child, index, depth + 1)
  }
  visit(document.root ?? document, -1, 0)
  return nodes
}

/** Does this node carry anything a human (or a model) could act on? */
export function isInteresting(node) {
  if (node.text || node.contentDesc || node.resourceId || node.hint) return true
  if (node.clickable || node.longClickable || node.scrollable || node.checkable) return true
  if (node.selected || node.checked || node.focused) return true
  return false
}

/** Does this node carry a label the model can read? */
export function hasLabel(node) {
  return Boolean(node.text || node.contentDesc || node.hint)
}

const CLASS_ALIASES = [
  [/android\.widget\.Button|MaterialButton/, 'Button'],
  [/android\.widget\.ImageView|ImageButton/, 'Image'],
  [/android\.widget\.TextView/, 'Text'],
  [/android\.widget\.EditText|AutoCompleteTextView/, 'Input'],
  [/android\.widget\.CheckBox|Switch|ToggleButton/, 'Toggle'],
  [/android\.widget\.RadioButton/, 'Radio'],
  [/android\.widget\.Spinner/, 'Spinner'],
  [/android\.widget\.ScrollView|NestedScrollView|RecyclerView|ListView|ViewPager/, 'Scroll'],
  [/android\.webkit\.WebView/, 'WebView'],
  [/android\.view\.ViewGroup|FrameLayout|LinearLayout|RelativeLayout|ConstraintLayout/, 'Group'],
  [/android\.view\.View$/, 'View'],
]

export function classAlias(className) {
  for (const [re, alias] of CLASS_ALIASES) if (re.test(className)) return alias
  return className ? className.split('.').pop() : '?'
}

/**
 * Build the compact, model-facing view of a screen.
 *
 * @param {object[]} nodes            flattened dump
 * @param {object} [options]
 * @param {boolean} [options.labelsOnly=false]  keep only nodes with text/desc
 * @param {number}  [options.maxNodes=200]      hard cap, keeps the top of the screen
 * @param {number}  [options.maxTextLength=120] truncate long labels
 * @param {boolean} [options.includeUnlabeled=false] keep tappable-but-unlabelled nodes
 * @param {string}  [options.package]           restrict to one package
 * @returns {{rows:object[], index:Map<number,object>, dropped:number}}
 */
export function simplify(nodes, options = {}) {
  const {
    labelsOnly = false,
    maxNodes = 200,
    maxTextLength = 120,
    includeUnlabeled = true,
    package: packageFilter = null,
    depthLimit = Number.POSITIVE_INFINITY,
  } = options

  const rows = []
  const index = new Map()
  let dropped = 0

  for (const node of nodes) {
    if (node.depth > depthLimit) {
      dropped++
      continue
    }
    if (packageFilter && node.package && node.package !== packageFilter) {
      dropped++
      continue
    }
    if (labelsOnly && !hasLabel(node)) {
      dropped++
      continue
    }
    const actionable = node.clickable || node.longClickable || node.scrollable || node.checkable
    if (!isInteresting(node)) {
      dropped++
      continue
    }
    if (!hasLabel(node) && actionable && !includeUnlabeled) {
      dropped++
      continue
    }
    if (!node.bounds || node.bounds.width <= 0 || node.bounds.height <= 0) {
      dropped++
      continue
    }

    const row = {
      node: rows.length,
      src: node.index,
      tag: classAlias(node.className),
      bounds: node.bounds,
      depth: node.depth,
    }
    if (node.text) row.text = truncate(node.text, maxTextLength)
    if (node.contentDesc) row.desc = truncate(node.contentDesc, maxTextLength)
    if (node.hint) row.hint = truncate(node.hint, maxTextLength)
    if (node.resourceId) row.id = shortId(node.resourceId)
    const flags = []
    if (node.clickable) flags.push('tap')
    if (node.longClickable) flags.push('long')
    if (node.scrollable) flags.push('scroll')
    if (node.checkable) flags.push(node.checked ? 'checked' : 'unchecked')
    if (node.selected) flags.push('selected')
    if (node.focused) flags.push('focused')
    if (node.password) flags.push('password')
    if (!node.enabled) flags.push('disabled')
    if (flags.length) row.flags = flags

    rows.push(row)
    index.set(row.node, node)
    if (rows.length >= maxNodes) {
      dropped += nodes.length - node.index - 1
      break
    }
  }

  return { rows, index, dropped }
}

function truncate(text, limit) {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized
}

/** Render simplified rows as newline-delimited text (compact, diff-friendly). */
export function rowsToText(rows, { withBounds = true } = {}) {
  return rows
    .map((row) => {
      const parts = [`#${row.node}`, row.tag]
      if (row.text) parts.push(JSON.stringify(row.text))
      if (row.desc) parts.push(`desc=${JSON.stringify(row.desc)}`)
      if (row.id) parts.push(`id=${row.id}`)
      if (row.hint) parts.push(`hint=${JSON.stringify(row.hint)}`)
      if (withBounds && row.bounds) parts.push(`@${row.bounds.cx},${row.bounds.cy}`)
      if (row.flags) parts.push(`[${row.flags.join(',')}]`)
      return parts.join(' ')
    })
    .join('\n')
}

// ── Querying ────────────────────────────────────────────────────────────────

/**
 * Selector semantics.
 *
 * `text` / `desc` / `id` accept a string (substring match), a RegExp, or an
 * array (any-of).  `exact: true` upgrades string matching to equality, which is
 * usually what you want when a label like "完成" also appears inside
 * "未完成".
 */
export function matchesSelector(node, selector = {}) {
  const { text, desc, id, className, exact = false, enabledOnly = true, visibleOnly = true } = selector

  if (enabledOnly && !node.enabled) return false
  if (visibleOnly && (!node.bounds || node.bounds.width <= 0 || node.bounds.height <= 0)) return false
  if (id && !matchField([node.resourceId, shortId(node.resourceId)], id, false)) return false
  if (className && !matchField([node.className, classAlias(node.className)], className, false)) return false
  if (text && !matchField([node.text], text, exact)) return false
  if (desc && !matchField([node.contentDesc, node.hint], desc, exact)) return false
  return true
}

function matchField(values, pattern, exact) {
  const candidates = values.filter((v) => v !== undefined && v !== null && v !== '')
  const patterns = Array.isArray(pattern) ? pattern : [pattern]
  for (const p of patterns) {
    for (const value of candidates) {
      if (p instanceof RegExp) {
        if (p.test(value)) return true
      } else if (exact) {
        if (value === p) return true
      } else if (value.includes(String(p))) {
        return true
      }
    }
  }
  return false
}

/**
 * Find matching nodes, best candidate first.
 *
 * Ranking prefers, in order: clickable, smaller bounds (the innermost element
 * that actually handles the tap), exact id over partial text.
 */
export function findNodes(nodes, selector = {}) {
  const hits = nodes.filter((node) => matchesSelector(node, selector))
  const wantClickable = selector.clickable !== false
  return hits.sort((a, b) => score(b, wantClickable) - score(a, wantClickable))
}

function score(node, wantClickable) {
  let value = 0
  if (wantClickable && node.clickable) value += 1000
  if (node.text) value += 20
  if (node.resourceId) value += 10
  const area = node.bounds ? node.bounds.width * node.bounds.height : 1e9
  value -= Math.min(area / 1000, 500) // prefer the smaller, innermost hit
  return value
}

/**
 * Nearest ancestor (or self) that can receive a tap — used when a labelled
 * `TextView` sits inside the `LinearLayout` that actually owns the click.
 */
export function clickableTarget(nodes, node) {
  let current = node
  const guard = 64
  for (let i = 0; i < guard && current; i++) {
    if (current.clickable && current.enabled) return current
    if (current.parentIndex < 0) break
    current = nodes[current.parentIndex]
  }
  return node
}

/** Convenience wrapper carrying the tree plus its derived indices. */
export class UiSnapshot {
  constructor({ nodes, rotation, source, hash, text = null }) {
    this.nodes = nodes
    this.rotation = rotation
    this.source = source
    this.hash = hash ?? null
    this.text = text
    this._simplified = null
  }

  static from(xml, options = {}) {
    const { root, rotation } = parseDump(xml)
    const nodes = flattenDump({ root })
    return new UiSnapshot({ nodes, rotation, source: 'uiautomator', hash: options.hash ?? null, text: xml })
  }

  /** Compact rows; computed once and reused. */
  simplify(options = {}) {
    if (!this._simplified || options.force) {
      this._simplified = simplify(this.nodes, options)
    }
    return this._simplified
  }

  find(selector) {
    return findNodes(this.nodes, selector)
  }

  /** Resolve a compact row number (`--node N`) back to a source node. */
  byRow(rowIndex, options = {}) {
    const { index } = this.simplify(options)
    return index.get(rowIndex) ?? null
  }

  get packages() {
    return [...new Set(this.nodes.map((n) => n.package).filter(Boolean))]
  }

  get texts() {
    return this.nodes.map((n) => n.text).filter(Boolean)
  }

  get screenSize() {
    // The `<hierarchy>` element itself has no bounds; the first element that
    // does is the top-level FrameLayout, which spans the whole screen.
    const root = this.nodes.find((n) => n.bounds && n.bounds.width > 0 && n.bounds.height > 0)
    return root?.bounds ? { width: root.bounds.width, height: root.bounds.height } : null
  }
}

export { decodeEntities, walk }
