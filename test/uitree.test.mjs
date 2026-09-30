import test from 'node:test'
import assert from 'node:assert/strict'
import { parseXml, walk, decodeEntities } from '../src/xml.js'
import { parseBounds, flattenDump, parseDump, simplify, findNodes, matchesSelector, clickableTarget, rowsToText, shortId } from '../src/uitree.js'

const SAMPLE = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>
<hierarchy rotation="0">
  <node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.demo" bounds="[0,0][720,1280]" clickable="false" enabled="true">
    <node index="0" text="登录" resource-id="com.demo:id/btn_login" class="android.widget.Button" package="com.demo" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="false" password="false" selected="false" bounds="[40,600][360,680]" />
    <node index="1" text="用户名" resource-id="com.demo:id/et_user" class="android.widget.EditText" package="com.demo" clickable="true" enabled="true" bounds="[40,400][680,470]" />
    <node index="2" text="第一行&#10;第二行" resource-id="com.demo:id/tv_multi" class="android.widget.TextView" package="com.demo" clickable="false" enabled="true" bounds="[40,200][680,260]" />
    <node index="3" text="" resource-id="com.demo:id/hidden" class="android.view.View" package="com.demo" clickable="false" enabled="false" bounds="[0,0][0,0]" />
  </node>
</hierarchy>`

test('parseXml reads nested nodes and attributes', () => {
  const document = parseXml(SAMPLE)
  assert.equal(document.name, 'hierarchy')
  assert.equal(document.attrs.rotation, '0')
  assert.equal(document.children.length, 1)
  const root = document.children[0]
  assert.equal(root.name, 'node')
  assert.equal(root.children.length, 4)
})

test('decodeEntities handles numeric and named references', () => {
  assert.equal(decodeEntities('a&#10;b'), 'a\nb')
  assert.equal(decodeEntities('a&amp;b'), 'a&b')
  assert.equal(decodeEntities('&#x41;'), 'A')
})

test('walk visits every element depth first', () => {
  const document = parseXml(SAMPLE)
  const seen = [...walk(document)].map(({ node }) => node.name)
  assert.equal(seen.length, 6)
  assert.deepEqual(seen, ['hierarchy', 'node', 'node', 'node', 'node', 'node'])
})

test('parseBounds extracts rect and centre', () => {
  assert.deepEqual(parseBounds('[40,600][360,680]'), {
    x1: 40, y1: 600, x2: 360, y2: 680, width: 320, height: 80, cx: 200, cy: 640,
  })
  assert.equal(parseBounds('nonsense'), null)
})

test('flattenDump preserves parent links', () => {
  const { root } = parseDump(SAMPLE)
  const nodes = flattenDump({ root })
  assert.equal(nodes.length, 6) // hierarchy + frame + 4 children
  const button = nodes.find((n) => n.resourceId.endsWith('btn_login'))
  assert.equal(button.parentIndex, 1)
  assert.equal(nodes[button.parentIndex].className, 'android.widget.FrameLayout')
})

test('shortId strips the package prefix', () => {
  assert.equal(shortId('com.demo:id/btn_login'), 'btn_login')
  assert.equal(shortId('btn_login'), 'btn_login')
  assert.equal(shortId(''), '')
})

test('simplify keeps actionable nodes and drops invisible ones', () => {
  const { root } = parseDump(SAMPLE)
  const nodes = flattenDump({ root })
  const { rows } = simplify(nodes)
  const ids = rows.map((r) => r.id)
  assert.ok(ids.includes('btn_login'))
  assert.ok(ids.includes('et_user'))
  assert.ok(ids.includes('tv_multi'))
  assert.ok(!ids.includes('hidden'), 'zero-area node must be dropped')
})

test('simplify marks tap targets and truncates text', () => {
  const { root } = parseDump(SAMPLE)
  const nodes = flattenDump({ root })
  const { rows } = simplify(nodes)
  const button = rows.find((r) => r.id === 'btn_login')
  assert.deepEqual(button.flags, ['tap'])
  const multi = rows.find((r) => r.id === 'tv_multi')
  assert.equal(multi.text, '第一行 第二行', 'newlines collapse to single spaces')
})

test('matchesSelector supports exact, substring and regex', () => {
  const { root } = parseDump(SAMPLE)
  const nodes = flattenDump({ root })
  const button = nodes.find((n) => n.resourceId.endsWith('btn_login'))
  assert.ok(matchesSelector(button, { text: '登录' }))
  assert.ok(matchesSelector(button, { text: /登./ }))
  assert.ok(!matchesSelector(button, { text: '登录', exact: false, id: 'nope' }))
  assert.ok(matchesSelector(button, { id: 'btn_login' }))
  assert.ok(!matchesSelector({ ...button, enabled: false }, { text: '登录' }), 'disabled nodes are excluded by default')
})

test('findNodes prefers the smaller clickable hit', () => {
  const xml = `<hierarchy rotation="0">
    <node class="android.widget.FrameLayout" package="p" bounds="[0,0][720,1280]" clickable="true" enabled="true" text="确定">
      <node class="android.widget.Button" package="p" bounds="[300,900][420,960]" clickable="true" enabled="true" text="确定" />
    </node>
  </hierarchy>`
  const { root } = parseDump(xml)
  const nodes = flattenDump({ root })
  const hits = findNodes(nodes, { text: '确定' })
  assert.equal(hits.length, 2)
  assert.equal(hits[0].className, 'android.widget.Button')
})

test('clickableTarget walks up to the element that owns the tap', () => {
  const xml = `<hierarchy rotation="0">
    <node class="android.widget.LinearLayout" package="p" bounds="[0,0][720,100]" clickable="true" enabled="true">
      <node class="android.widget.TextView" package="p" bounds="[10,10][100,40]" clickable="false" enabled="true" text="标题" />
    </node>
  </hierarchy>`
  const { root } = parseDump(xml)
  const nodes = flattenDump({ root })
  const label = nodes.find((n) => n.text === '标题')
  const target = clickableTarget(nodes, label)
  assert.equal(target.className, 'android.widget.LinearLayout')
})

test('rowsToText renders a compact one-line-per-node form', () => {
  const { root } = parseDump(SAMPLE)
  const nodes = flattenDump({ root })
  const text = rowsToText(simplify(nodes).rows)
  assert.match(text, /^#0 /
  )
  assert.match(text, /Button "登录" id=btn_login @200,640 \[tap\]/)
})

test('parseDump rejects empty input', () => {
  const { root, rotation } = parseDump('<hierarchy rotation="1"></hierarchy>')
  assert.equal(rotation, 1)
  assert.equal(root.name, 'hierarchy')
  assert.throws(() => parseDump('   '), /空|合法/)
})
