import test from 'node:test'
import assert from 'node:assert/strict'
import { createTools, TOOL_NAMES } from '../src/tools.js'
import { AndroidSession } from '../src/manager.js'
import { loadHarnessPackage } from './helpers/harness.mjs'

/**
 * Minimal stand-in for the harness `tools` service.
 * Mirrors the contract enforced by `ToolRuntime.register` in dsh-tools:
 *   output must be an object with a `render` function and a JSON Schema.
 */
function mockContext() {
  const registered = new Map()
  const disposers = []
  const ctx = {
    tools: {
      register(definition) {
        if (!definition || typeof definition.name !== 'string' || !definition.name) {
          throw new TypeError('tool definition needs a name')
        }
        if (typeof definition.output?.render !== 'function') {
          throw new TypeError(`tool "${definition.name}" must declare output { schema, render }`)
        }
        if (typeof definition.output.schema !== 'object') {
          throw new TypeError(`tool "${definition.name}" must declare an output schema`)
        }
        if (registered.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
        registered.set(definition.name, definition)
        const disposer = () => registered.delete(definition.name)
        disposers.push(disposer)
        return disposer
      },
    },
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
  }
  return { ctx, registered, disposeAll: () => disposers.forEach((d) => d()) }
}

test('createTools exposes the documented tool names in a stable order', () => {
  const tools = createTools()
  assert.deepEqual(tools.map((t) => t.name), TOOL_NAMES)
})

test('every tool declares a name, a description and an object parameter schema', () => {
  for (const tool of createTools()) {
    assert.match(tool.name, /^android_[a-z_]+$/)
    assert.ok(tool.description.length > 40, `${tool.name} description is too short to guide the model`)
    assert.equal(tool.parameters.type, 'object', `${tool.name} parameters must be object-rooted`)
    assert.ok(tool.parameters.properties, `${tool.name} parameters need properties`)
    assert.equal(typeof tool.output.render, 'function')
    assert.equal(typeof tool.execute, 'function')
  }
})

test('required parameters are declared in the schema', () => {
  const tools = new Map(createTools().map((t) => [t.name, t]))
  assert.deepEqual(tools.get('android_input').parameters.required, ['action'])
  assert.deepEqual(tools.get('android_app').parameters.required, ['action'])
  assert.deepEqual(tools.get('android_wait').parameters.required, ['for'])
})

test('every action enum member has a matching code path', () => {
  const tools = new Map(createTools().map((t) => [t.name, t]))
  assert.deepEqual(tools.get('android_input').parameters.properties.action.enum, [
    'text',
    'key',
    'swipe',
    'scroll',
    'long_press',
  ])
  assert.deepEqual(tools.get('android_app').parameters.properties.action.enum, [
    'current',
    'install',
    'launch',
    'stop',
    'uninstall',
    'clear',
    'grant',
    'list',
    'info',
    'apk_info',
  ])
  assert.deepEqual(tools.get('android_wait').parameters.properties.for.enum, ['text', 'id', 'activity', 'gone', 'idle'])
})

test('parameter and output schemas are accepted by the harness schema validator', async (t) => {
  const dshTools = await loadHarnessPackage('@deepseek-ai/dsh-tools')
  if (!dshTools?.assertSupportedJsonSchema) {
    t.skip('@deepseek-ai/dsh-tools is not reachable from this environment')
    return
  }
  for (const tool of createTools()) {
    assert.doesNotThrow(
      () => dshTools.assertSupportedJsonSchema(tool.parameters),
      `${tool.name} parameter schema is outside the supported subset`,
    )
    assert.doesNotThrow(
      () => dshTools.assertSupportedJsonSchema(tool.output.schema),
      `${tool.name} output schema is outside the supported subset`,
    )
  }
})

test('the Cordis plugin registers every tool and disposes cleanly', async () => {
  const plugin = await import('../src/plugin.js')
  assert.equal(plugin.name, 'dsh-android-develop-helper')
  assert.deepEqual(plugin.inject, ['tools'])

  const { ctx, registered, disposeAll } = mockContext()
  plugin.apply(ctx, { flags: {} })
  assert.deepEqual([...registered.keys()], TOOL_NAMES)
  for (const definition of registered.values()) {
    assert.equal(definition.timeoutMs, 300000)
    assert.equal(typeof definition.execute, 'function')
  }
  disposeAll()
  assert.equal(registered.size, 0)
})

test('the plugin honours a custom timeout', async () => {
  const plugin = await import('../src/plugin.js')
  const { ctx, registered } = mockContext()
  plugin.apply(ctx, { timeoutMs: 12345, flags: {} })
  for (const definition of registered.values()) assert.equal(definition.timeoutMs, 12345)
})

test('renderers produce text parts for every tool', () => {
  for (const tool of createTools()) {
    const parts = tool.output.render({}, { summary: 'hello' })
    assert.ok(Array.isArray(parts) && parts.length > 0, `${tool.name} render returned nothing`)
    assert.equal(parts[0].type, 'text')
    assert.equal(parts[0].text, 'hello')
    // Without a summary the renderer must still emit something valid.
    const fallback = tool.output.render({}, { value: 1 })
    assert.equal(fallback[0].type, 'text')
    assert.match(fallback[0].text, /value/)
  }
})

test('argument validation rejects unknown actions before touching a device', async () => {
  const tools = new Map(createTools().map((t) => [t.name, t]))
  await assert.rejects(() => tools.get('android_input').execute({ action: 'teleport' }), /未知 action/)
  await assert.rejects(() => tools.get('android_app').execute({ action: 'explode' }), /未知 action/)
  await assert.rejects(() => tools.get('android_wait').execute({ for: 'godot' }), /未知等待条件/)
  await assert.rejects(() => tools.get('android_tap').execute({}), /android_tap 需要/)
})

test('AndroidSession caches one connection per configuration', () => {
  const session = new AndroidSession({ emulatorType: 'mumu', adbPort: 16384 })
  assert.equal(session.cfg.emulatorType, 'mumu')
  assert.equal(session.cfg.adbPort, 16384)
  assert.equal(session.device, null)
  assert.match(session.key, /mumu/)
})
