/**
 * Reads a DSH plugin market index and exposes the three operations the MCP tools need.
 *
 * The index is public JSON; there is no DSH runtime here. Installation state and
 * profile version exemptions are therefore unavailable, and compatibility comes
 * from the declared engines.dsh ranges only.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { compare as compareSemver, parseVersion, satisfies } from './semver.js'
import { formatCompatibility, formatDetail, formatSearch, oneLine, textOf } from './format.js'

const require = createRequire(import.meta.url)
const { version: PACKAGE_VERSION } = require('../package.json')

const DEFAULT_INDEX = 'https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json'
const CACHE_TTL_MS = 600_000
const FETCH_TIMEOUT_MS = 20_000
const DESCRIPTION_MAX_CHARS = 180
const LIMIT_DEFAULT = 10
const LIMIT_MAX = 25

let cache = null
let inflight = null

export function indexUrl() {
  const value = process.env.DSH_MARKET_INDEX
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : DEFAULT_INDEX
}

export function configuredVersion() {
  const value = process.env.DSH_VERSION
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function isFileSource(url) {
  return url.startsWith('file:') || (!/^https?:/i.test(url) && existsSync(url))
}

async function readDocument(url) {
  if (isFileSource(url)) {
    const path = url.startsWith('file:') ? fileURLToPath(url) : url
    return JSON.parse(await readFile(path, 'utf8'))
  }
  const response = await fetch(url, {
    headers: { 'user-agent': `dsh-market-mcp/${PACKAGE_VERSION}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`index request failed with HTTP ${response.status}`)
  return response.json()
}

export async function loadIndex(url = indexUrl(), { refresh = false } = {}) {
  const now = Date.now()
  if (!refresh && cache !== null && cache.url === url && now - cache.at < CACHE_TTL_MS) return cache.document
  if (!refresh && inflight !== null && inflight.url === url) return inflight.promise
  const promise = (async () => {
    const document = await readDocument(url)
    if (document === null || typeof document !== 'object' || !Array.isArray(document.plugins)) {
      throw new Error('index document is not a plugin market index')
    }
    cache = { url, at: Date.now(), document }
    return document
  })()
  inflight = { url, promise }
  try {
    return await promise
  } finally {
    if (inflight !== null && inflight.promise === promise) inflight = null
  }
}

function sortedVersions(plugin) {
  return (Array.isArray(plugin.versions) ? plugin.versions : [])
    .filter((version) => version !== null && typeof version === 'object')
    .sort((left, right) => -compareVersions(String(left.version), String(right.version)))
}

export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null && b === null) return 0
  if (a === null) return -1
  if (b === null) return 1
  return compareSemver(a, b)
}

function versionCompatibility(version, runtime) {
  const range = version.engines === null || typeof version.engines !== 'object' ? undefined : version.engines.dsh
  if (typeof range !== 'string' || range.trim() === '') return undefined
  if (runtime === undefined) return undefined
  // Without a readable target version nothing can be checked, so the row keeps
  // the compatibility unknown rather than claiming a mismatch.
  if (parseVersion(runtime) === null) return undefined
  const result = satisfies(runtime, range)
  if (result.valid !== true) {
    // The harness check fails closed on a range it cannot read, so the version
    // is not installable there either; say why instead of reporting "no".
    return {
      compatible: false,
      unreadable: true,
      runtimeVersion: runtime,
      requirements: { 'engines.dsh': range },
      exempted: false,
    }
  }
  return result.ok
    ? { compatible: true }
    : { compatible: false, runtimeVersion: runtime, requirements: { 'engines.dsh': range }, exempted: false }
}

function installTarget(name, version) {
  const source = version.source
  if (source !== null && typeof source === 'object' && source.type === 'git' && typeof source.url === 'string') {
    const base = source.url.replace(/\.git$/u, '')
    const path = typeof source.path === 'string' && source.path !== '' ? `&path:/${source.path}` : ''
    return { spec: `git+${base}.git#${String(source.commit ?? '')}${path}` }
  }
  return {
    spec: `${name}@${String(version.version)}`,
    ...(source !== null && typeof source === 'object' && typeof source.registry === 'string' && source.registry !== ''
      ? { registry: source.registry }
      : {}),
  }
}

function isInstallable(version) {
  const range = version.engines === null || typeof version.engines !== 'object' ? undefined : version.engines.dsh
  if (typeof range !== 'string' || range.trim() === '') return true
  // Without a target version every declared version is a candidate; the row
  // still shows that compatibility is unknown.
  if (version.compatibility === undefined) return true
  return version.compatibility.compatible === true
}

function defaultVersionOf(versions) {
  const installable = versions.filter(isInstallable)
  const stable = installable.find((version) => {
    const parsed = parseVersion(String(version.version))
    return parsed !== null && parsed.prerelease.length === 0
  })
  return (stable ?? installable[0])?.version
}

function toEntry(plugin, runtime) {
  const versions = sortedVersions(plugin).map((version) => ({
    ...version,
    install: installTarget(plugin.name, version),
    compatibility: versionCompatibility(version, runtime),
  }))
  return {
    ...plugin,
    versions,
    defaultVersion: defaultVersionOf(versions),
    installation: { status: 'unknown' },
  }
}

function resultDocument(document, url, runtime, entries, total) {
  return {
    index: { url, title: textOf(document.title) },
    result: {
      metadata: document.metadata,
      entries: entries.map((plugin) => toEntry(plugin, runtime)),
      total,
    },
  }
}

function normalize(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase()
}

function tokenize(text) {
  return normalize(text).split(/[^\p{L}\p{N}]+/u).filter((word) => word !== '')
}

function categoryTitle(document, id) {
  const categories = document.metadata === null || typeof document.metadata !== 'object' ? undefined : document.metadata.categories
  const declaration = categories === null || typeof categories !== 'object' ? undefined : categories[id]
  return declaration === undefined || declaration === null ? '' : textOf(declaration.title)
}

function scoreWord(word, fields) {
  let score = 0
  if (fields.name === word) score = Math.max(score, 100)
  else if (fields.name.startsWith(word)) score = Math.max(score, 80)
  else if (fields.name.includes(word)) score = Math.max(score, 50)
  if (fields.title.includes(word)) score = Math.max(score, 30)
  if (fields.keywords.includes(word)) score = Math.max(score, 20)
  if (fields.category.includes(word)) score = Math.max(score, 15)
  if (fields.description.includes(word)) score = Math.max(score, 8)
  return score
}

function newestTimestamp(plugin) {
  let newest = 0
  for (const version of Array.isArray(plugin.versions) ? plugin.versions : []) {
    if (version !== null && typeof version === 'object' && Number.isFinite(version.publishTimestamp)) {
      newest = Math.max(newest, version.publishTimestamp)
    }
  }
  return newest
}

function integerOption(value, fallback, minimum, maximum) {
  if (value === undefined || value === null) return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, parsed))
}

/** Search the index and render compact text. */
export async function searchPlugins({ keyword = '', category, limit, offset, sort } = {}, options = {}) {
  const url = options.url ?? indexUrl()
  const document = await loadIndex(url)
  const runtime = options.runtime ?? configuredVersion()
  const words = tokenize(keyword)
  const pageOffset = integerOption(offset, 0, 0, 1_000_000)
  const pageLimit = integerOption(limit, LIMIT_DEFAULT, 1, LIMIT_MAX)
  const mode = sort === 'recent' ? 'recent' : 'relevance'

  const scored = []
  document.plugins.forEach((plugin, index) => {
    if (plugin === null || typeof plugin !== 'object') return
    const pluginCategory = plugin.metadata === null || typeof plugin.metadata !== 'object' ? undefined : plugin.metadata.category
    if (typeof category === 'string' && category !== '' && pluginCategory !== category) return
    const fields = {
      name: normalize(plugin.name),
      title: normalize(textOf(plugin.title)),
      keywords: normalize(Array.isArray(plugin.metadata?.keywords) ? plugin.metadata.keywords.join(' ') : ''),
      category: normalize(categoryTitle(document, pluginCategory)),
      description: normalize([
        textOf(plugin.description),
        ...(Array.isArray(plugin.metadata?.labels) ? plugin.metadata.labels : []),
      ].join(' ')),
    }
    let score = 0
    for (const word of words) {
      const hit = scoreWord(word, fields)
      if (hit === 0) return
      score += hit
    }
    scored.push({ plugin, index, score, timestamp: newestTimestamp(plugin) })
  })

  if (mode === 'recent') scored.sort((left, right) => right.timestamp - left.timestamp || left.index - right.index)
  else scored.sort((left, right) => right.score - left.score || left.index - right.index)

  const total = scored.length
  const page = scored.slice(pageOffset, pageOffset + pageLimit).map((row) => row.plugin)
  const pageDocument = resultDocument(document, url, runtime, page, total)
  return formatSearch({
    pages: [pageDocument],
    keyword,
    category: typeof category === 'string' && category !== '' ? category : undefined,
    offset: pageOffset,
    sort: mode,
    now: Date.now(),
    maxChars: DESCRIPTION_MAX_CHARS,
  })
}

function editDistance(left, right, limit) {
  if (Math.abs(left.length - right.length) > limit) return limit + 1
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row]
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      )
    }
    previous = current
  }
  return previous[right.length]
}

function suggestions(document, name) {
  const wanted = normalize(name)
  const found = []
  for (const plugin of document.plugins) {
    if (plugin === null || typeof plugin !== 'object' || typeof plugin.name !== 'string') continue
    const candidate = normalize(plugin.name)
    if (!candidate.includes(wanted) && editDistance(candidate, wanted, 3) > 3) continue
    if (found.includes(plugin.name)) continue
    found.push(plugin.name)
    if (found.length >= 5) break
  }
  return found
}

function findPlugin(document, name) {
  return document.plugins.find((plugin) => plugin !== null && typeof plugin === 'object' && plugin.name === name)
}

function requirePluginName(name) {
  if (typeof name !== 'string' || name.trim() === '') throw new Error('plugin_name is required')
  return name.trim()
}

/** Full metadata for one plugin, rendered as text. */
export async function getPluginDetail({ pluginName, version } = {}, options = {}) {
  const wanted = requirePluginName(pluginName)
  if (typeof version === 'string' && version.trim() !== '' && parseVersion(version.trim()) === null) {
    throw new Error(`"${oneLine(version)}" is not a semantic version; pass a listed version or omit it.`)
  }
  const url = options.url ?? indexUrl()
  const document = await loadIndex(url)
  const runtime = options.runtime ?? configuredVersion()
  const title = textOf(document.title) || url
  const plugin = findPlugin(document, wanted)
  if (plugin === undefined) {
    const near = suggestions(document, wanted)
    return [`No plugin named "${oneLine(wanted)}" is listed by ${title}.`, near.length > 0 ? `Near matches: ${near.join(', ')}` : '']
      .filter((line) => line !== '')
      .join('\n')
  }
  return formatDetail({
    entry: toEntry(plugin, runtime),
    indexTitle: title,
    now: Date.now(),
    runtimeVersion: runtime,
    maxChars: 260,
    focusVersion: typeof version === 'string' && version.trim() !== '' ? version.trim() : undefined,
  })
}

/** Compatibility report for one plugin against a target DSH version. */
export async function checkCompatibility({ pluginName, dshVersion } = {}, options = {}) {
  const wanted = requirePluginName(pluginName)
  const target = typeof dshVersion === 'string' && dshVersion.trim() !== ''
    ? dshVersion.trim()
    : options.runtime ?? configuredVersion()
  if (target === undefined) {
    throw new Error('Pass dsh_version, or set DSH_VERSION, so compatibility has a version to check.')
  }
  if (parseVersion(target) === null) {
    throw new Error(`"${oneLine(target)}" is not a semantic version, for example 0.2.2-rc.3 or 0.3.0-rc.1.`)
  }
  const url = options.url ?? indexUrl()
  const document = await loadIndex(url)
  const title = textOf(document.title) || url
  const plugin = findPlugin(document, wanted)
  if (plugin === undefined) {
    const near = suggestions(document, wanted)
    return [`No plugin named "${oneLine(wanted)}" is listed by ${title}.`, near.length > 0 ? `Near matches: ${near.join(', ')}` : '']
      .filter((line) => line !== '')
      .join('\n')
  }
  return formatCompatibility({
    entry: toEntry(plugin, target),
    indexTitle: title,
    runtimeVersion: target,
  })
}
