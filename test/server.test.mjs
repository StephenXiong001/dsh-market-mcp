/** Unit tests for the market layer and protocol tests for the stdio server. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkCompatibility, getPluginDetail, loadIndex, searchPlugins } from '../lib/market.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixture = join(here, 'fixtures', 'index.json')
const server = join(here, '..', 'bin', 'server.js')

process.env.DSH_MARKET_INDEX = fixture

async function withVersion(value, operation) {
  const previous = process.env.DSH_VERSION
  if (value === undefined) delete process.env.DSH_VERSION
  else process.env.DSH_VERSION = value
  try {
    return await operation()
  } finally {
    if (previous === undefined) delete process.env.DSH_VERSION
    else process.env.DSH_VERSION = previous
  }
}

test('loads and validates the index', async () => {
  const document = await loadIndex(fixture)
  assert.equal(document.plugins.length, 3)
})

test('search returns compact rows and honors keyword and category', async () => {
  await withVersion('0.2.2', async () => {
    const alpha = await searchPlugins({ keyword: 'alpha' })
    assert.match(alpha, /^Fixture Market: 1 match for "alpha", showing 1$/m)
    assert.match(alpha, /^1\. demo-alpha/m)
    assert.match(alpha, /0\.1\.0 .*DSH ok .*install: demo-alpha@0\.1\.0/)

    const memory = await searchPlugins({ category: 'memory' })
    assert.match(memory, /1 plugin, category=memory, showing 1/)
    assert.match(memory, /demo-beta/)
  })
})

test('search reports available categories when nothing matches', async () => {
  const text = await searchPlugins({ keyword: 'does-not-exist' })
  assert.match(text, /no matches for "does-not-exist"/)
  assert.match(text, /categories: tools, memory/)
})

test('detail picks the compatible version and shows every range', async () => {
  await withVersion('0.2.2', async () => {
    const text = await getPluginDetail({ pluginName: 'demo-alpha' })
    assert.match(text, /^demo-alpha \(Demo Alpha\)$/m)
    assert.match(text, /^default: 0\.1\.0 \(DSH ok\)$/m)
    assert.match(text, /0\.2\.0 .*DSH no >=0\.3\.0/)
    assert.match(text, /0\.1\.0 .*DSH ok >=0\.2\.0/)
    assert.match(text, /^install: demo-alpha@0\.1\.0$/m)
  })
})

test('detail renders a git install spec and an undeclared version', async () => {
  const text = await getPluginDetail({ pluginName: 'demo-beta' })
  assert.match(text, /demo-beta/)
  assert.match(text, /install: git\+https:\/\/github\.com\/example\/demo-beta\.git#abc123&path:\/packages\/beta/)
  assert.match(text, /DSH undeclared/)
})

test('compatibility follows the declared range for the requested version', async () => {
  const old = await checkCompatibility({ pluginName: 'demo-alpha', dshVersion: '0.2.2' })
  assert.match(old, /^demo-alpha: compatible \(dsh 0\.2\.2\)$/m)
  assert.match(old, /0\.1\.0: ok, >=0\.2\.0/)
  assert.match(old, /^install: demo-alpha@0\.1\.0$/m)

  const newer = await checkCompatibility({ pluginName: 'demo-alpha', dshVersion: '0.3.5' })
  assert.match(newer, /^demo-alpha: compatible \(dsh 0\.3\.5\)$/m)
  assert.match(newer, /^install: demo-alpha@0\.2\.0$/m)

  const pinned = await checkCompatibility({ pluginName: 'demo-gamma', dshVersion: '0.2.2' })
  assert.match(pinned, /^demo-gamma: incompatible \(dsh 0\.2\.2\)$/m)
  assert.match(pinned, /install: none \(no version admits this dsh\)/)
})

test('an undeclared requirement is reported as unverified', async () => {
  const text = await checkCompatibility({ pluginName: 'demo-beta', dshVersion: '0.2.2' })
  assert.match(text, /^demo-beta: undeclared \(dsh 0\.2\.2\)$/m)
  assert.match(text, /no version declares engines\.dsh; install is allowed but compatibility is unverified/)
  assert.match(text, /^install: git\+/m)
})

test('compatibility needs a version when the environment has none', async () => {
  await withVersion(undefined, async () => {
    await assert.rejects(checkCompatibility({ pluginName: 'demo-alpha' }), /Pass dsh_version, or set DSH_VERSION/)
  })
})

test('a missing plugin points at close names', async () => {
  const text = await getPluginDetail({ pluginName: 'demo-alpa' })
  assert.match(text, /No plugin named "demo-alpa"/)
  assert.match(text, /Near matches: demo-alpha/)
})

test('search sorts by publish date and clamps the page', async () => {
  await withVersion('0.2.2', async () => {
    const recent = await searchPlugins({ sort: 'recent' })
    assert.match(recent, /^1\. demo-gamma/m)

    const page = await searchPlugins({ limit: 999, offset: 2 })
    assert.match(page, /showing 1, from 2/)
    assert.match(page, /demo-gamma/)
  })
})

test('detail focuses one listed version and installs it', async () => {
  await withVersion('0.2.2', async () => {
    const text = await getPluginDetail({ pluginName: 'demo-alpha', version: '0.2.0' })
    assert.match(text, /^selected: 0\.2\.0 \(DSH no\)$/m)
    assert.match(text, /^install: demo-alpha@0\.2\.0$/m)
  })
})

test('without DSH_VERSION detail reports the latest version, not a default', async () => {
  await withVersion(undefined, async () => {
    const text = await getPluginDetail({ pluginName: 'demo-alpha' })
    assert.match(text, /^latest: 0\.2\.0 \(compatibility unknown; set DSH_VERSION\)$/m)
    assert.match(text, /^install: demo-alpha@0\.2\.0$/m)
  })
})

function waitFor(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = () => {
      const value = predicate()
      if (value !== undefined) {
        resolve(value)
        return
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('timeout waiting for output'))
        return
      }
      setTimeout(poll, 25)
    }
    poll()
  })
}

function startServer(env = {}) {
  const child = spawn(process.execPath, [server], {
    env: { ...process.env, DSH_MARKET_INDEX: fixture, DSH_VERSION: '0.2.2', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  const rawLines = []
  const reader = createInterface({ input: child.stdout })
  reader.on('line', (line) => {
    rawLines.push(line)
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const resolve = pending.get(message.id)
      pending.delete(message.id)
      resolve(message)
    }
  })
  let nextId = 1
  return {
    child,
    rawLines,
    request(method, params) {
      const id = nextId++
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`timeout waiting for ${method}`))
        }, 10_000)
        pending.set(id, (message) => {
          clearTimeout(timer)
          resolve(message)
        })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    },
  }
}

test('stdio server completes the MCP handshake, lists tools, and calls one', async () => {
  const client = startServer()
  try {
    const initialized = await client.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    })
    assert.equal(initialized.result.protocolVersion, '2025-06-18')
    assert.equal(initialized.result.serverInfo.name, 'dsh-market-mcp')
    assert.deepEqual(Object.keys(initialized.result.capabilities), ['tools'])

    client.notify('notifications/initialized', {})

    const listed = await client.request('tools/list', {})
    assert.deepEqual(listed.result.tools.map((tool) => tool.name).sort(), ['check_plugin_compatibility', 'get_plugin_detail', 'search_plugins'])
    for (const tool of listed.result.tools) {
      assert.equal(tool.inputSchema.type, 'object')
    }

    const called = await client.request('tools/call', {
      name: 'search_plugins',
      arguments: { keyword: 'alpha' },
    })
    assert.equal(called.result.isError, false)
    assert.match(called.result.content[0].text, /demo-alpha/)

    const failed = await client.request('tools/call', {
      name: 'missing_tool',
      arguments: {},
    })
    assert.equal(failed.result.isError, true)
    assert.match(failed.result.content[0].text, /Unknown tool/)

    const unknown = await client.request('unknown/method', {})
    assert.equal(unknown.error.code, -32601)

    assert.ok(client.rawLines.length >= 4)
    for (const line of client.rawLines) assert.doesNotThrow(() => JSON.parse(line))
  } finally {
    client.child.kill()
  }
})

test('stdio server rejects malformed input without writing non-JSON to stdout', async () => {
  const client = startServer()
  try {
    client.child.stdin.write('not json\n')
    const line = await waitFor(() => (client.rawLines.length >= 1 ? client.rawLines[0] : undefined))
    const parsed = JSON.parse(line)
    assert.equal(parsed.error.code, -32700)
    assert.equal(parsed.id, null)
  } finally {
    client.child.kill()
  }
})


