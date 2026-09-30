/**
 * Minimal, tolerant XML reader.
 *
 * uiautomator dumps are machine-generated and structurally simple, so pulling in
 * an XML library would buy nothing but a dependency.  This parser handles what
 * the dumps actually contain: nested elements, self-closing tags, single- or
 * double-quoted attributes, and the five predefined entities plus numeric
 * character references (`&#10;` shows up in real dumps as a line break inside
 * `text`).
 */

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
}

export function decodeEntities(text) {
  if (!text || !text.includes('&')) return text
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[body] ?? whole
  })
}

/**
 * Parse a document into a node tree.
 * @returns {{name:string, attrs:Record<string,string>, children:object[]}|null}
 */
export function parseXml(source) {
  const root = { name: '#document', attrs: {}, children: [] }
  const stack = [root]
  const tagRe = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^<>]*?)?)(\/?)>/g
  let match

  while ((match = tagRe.exec(source)) !== null) {
    const [, closing, name, rawAttrs, selfClosing] = match
    if (closing === '/') {
      // Unwind to the matching open tag; ignore stray closers.
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === name) {
          stack.length = i
          break
        }
      }
      continue
    }
    const node = { name, attrs: parseAttrs(rawAttrs), children: [] }
    stack[stack.length - 1].children.push(node)
    if (!selfClosing) stack.push(node)
  }

  return root.children[0] ?? (root.children.length ? root : null)
}

function parseAttrs(raw) {
  const attrs = {}
  if (!raw) return attrs
  const attrRe = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let match
  while ((match = attrRe.exec(raw)) !== null) {
    attrs[match[1]] = decodeEntities(match[2] ?? match[3] ?? '')
  }
  return attrs
}

/** Depth-first walk over an element tree. */
export function* walk(node, depth = 0) {
  if (!node) return
  yield { node, depth }
  for (const child of node.children ?? []) yield* walk(child, depth + 1)
}
