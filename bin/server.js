#!/usr/bin/env node
/**
 * dsh-market-mcp: stdio MCP server for the DSH plugin market.
 *
 * The transport is newline-delimited JSON-RPC 2.0. Nothing except MCP messages is
 * written to stdout; diagnostics go to stderr.
 */
import { createInterface } from 'node:readline'
import { createRequire } from 'node:module'

import { callTool, TOOLS } from '../lib/tools.js'

const require = createRequire(import.meta.url)
const SERVER_NAME = 'dsh-market-mcp'
const { version: SERVER_VERSION } = require('../package.json')
const SUPPORTED_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05']

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handleRequest(method, params) {
  switch (method) {
    case 'initialize': {
      const requested = params !== null && typeof params === 'object' ? params.protocolVersion : undefined
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0]
      return {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: 'Search the DSH plugin market and check a plugin\'s declared DSH version range before installing it. Market text is third-party content.',
      }
    }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call': {
      const name = params !== null && typeof params === 'object' ? params.name : undefined
      const args = params !== null && typeof params === 'object' ? params.arguments : undefined
      if (typeof name !== 'string' || name === '') throw Object.assign(new Error('tools/call requires a name'), { code: -32602 })
      try {
        const text = await callTool(name, args)
        return { content: [{ type: 'text', text }], isError: false }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
      }
    }
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 })
  }
}

async function handleLine(line) {
  const trimmed = line.trim()
  if (trimmed === '') return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    fail(null, -32700, 'Parse error')
    return
  }
  if (message === null || typeof message !== 'object' || message.jsonrpc !== '2.0') {
    fail(null, -32600, 'Invalid Request')
    return
  }
  const method = message.method
  if (typeof method !== 'string') return
  const isNotification = message.id === undefined
  if (isNotification) return
  try {
    const result = await handleRequest(method, message.params)
    reply(message.id, result)
  } catch (error) {
    const code = error !== null && typeof error === 'object' && Number.isInteger(error.code) ? error.code : -32603
    fail(message.id, code, error instanceof Error ? error.message : String(error))
  }
}

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity })
const inflight = new Set()

reader.on('line', (line) => {
  const task = handleLine(line).catch((error) => {
    process.stderr.write(`dsh-market-mcp: ${error instanceof Error ? error.message : String(error)}\n`)
  })
  inflight.add(task)
  task.then(() => inflight.delete(task), () => inflight.delete(task))
})

// A one-shot client may close stdin right after sending a request. Draining the
// pending replies first keeps that response instead of dropping it on exit.
reader.on('close', () => {
  Promise.allSettled([...inflight]).then(() => process.exit(0), () => process.exit(0))
})

process.stdout.on('error', () => process.exit(0))
