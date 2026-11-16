/**
 * Renders market records as plain text.
 *
 * One field per line, single spaces between values, ASCII only. Descriptions are
 * clipped with "..." so a search page stays small; full metadata is only paid for
 * on an explicit detail call.
 */
import { satisfies, compare as compareSemver, parseVersion } from './semver.js'

const MS_PER_DAY = 86_400_000

export function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function safeSlice(text, end) {
  const cut = text.slice(0, end)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

export function clip(text, maxChars) {
  const clean = oneLine(text)
  if (clean.length <= maxChars) return clean
  const cut = safeSlice(clean, Math.max(1, maxChars - 3))
  const boundary = cut.lastIndexOf(' ')
  const head = boundary > maxChars * 0.6 ? cut.slice(0, boundary) : cut
  return `${head.trimEnd()}...`
}

export function textOf(value, language = 'en') {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value !== 'object') return ''
  const preferred = value[language]
  if (typeof preferred === 'string' && preferred.trim() !== '') return preferred.trim()
  if (language !== 'en' && typeof value.en === 'string' && value.en.trim() !== '') return value.en.trim()
  for (const key of Object.keys(value)) {
    const candidate = value[key]
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim()
  }
  return ''
}

export function authorOf(entry) {
  if (typeof entry.author === 'string' && entry.author.trim() !== '') return entry.author.trim()
  const title = textOf(entry.title)
  const slash = title.indexOf('/')
  if (slash > 0) {
    const owner = title.slice(0, slash)
    if (/^[@\w.-]+$/.test(owner)) return owner
  }
  const repository = entry.repository
  const url = repository !== null && typeof repository === 'object' ? repository.url : undefined
  if (typeof url === 'string') {
    const match = /(?:github\.com|gitlab\.com|gitee\.com)[/:]([^/]+)\//.exec(url)
    if (match !== null) return match[1]
  }
  return undefined
}

export function ageLabel(publishTimestamp, nowMs) {
  if (typeof publishTimestamp !== 'number' || !Number.isFinite(publishTimestamp)) return 'date unknown'
  const days = Math.max(0, Math.floor((nowMs - publishTimestamp * 1000) / MS_PER_DAY))
  return days === 0 ? 'today' : `${days}d`
}

export function isoDate(publishTimestamp) {
  if (typeof publishTimestamp !== 'number' || !Number.isFinite(publishTimestamp)) return 'date unknown'
  return new Date(publishTimestamp * 1000).toISOString().slice(0, 10)
}

function framework(version) {
  const engines = version.engines
  if (engines === null || typeof engines !== 'object' || typeof engines.dsh !== 'string') return ''
  return engines.dsh.trim()
}

export function verdictOf(version) {
  const range = framework(version)
  if (range === '') return { status: 'undeclared', range: '' }
  const compatibility = version.compatibility
  if (compatibility === null || typeof compatibility !== 'object') return { status: 'unknown', range }
  if (compatibility.compatible === true) return { status: 'compatible', range }
  if (compatibility.compatible === false) {
    return {
      status: 'incompatible',
      range,
      requirements: compatibility.requirements,
      runtimeVersion: compatibility.runtimeVersion,
      exempted: compatibility.exempted === true,
    }
  }
  return { status: 'unknown', range }
}

export function verdictTag(verdict) {
  switch (verdict.status) {
    case 'compatible': return 'ok'
    case 'incompatible': return verdict.exempted === true ? 'no (exemption active)' : 'no'
    case 'undeclared': return 'undeclared'
    case 'unreadable': return 'unreadable'
    default: return 'unknown'
  }
}

export function installationLabel(entry) {
  const installation = entry.installation
  if (installation === null || typeof installation !== 'object') return 'install state unknown'
  const version = typeof installation.installedVersion === 'string' ? ` ${installation.installedVersion}` : ''
  switch (installation.status) {
    case 'installed': return `installed${version}`
    case 'update-available': return `installed${version}, update available`
    case 'different-version': return `installed${version}, other version`
    case 'provided': return 'shipped with DSH'
    case 'unknown': return 'not tracked'
    default: return 'not installed'
  }
}

export function installSpecOf(entry, version) {
  const target = version === undefined ? undefined : version.install
  const spec = target === undefined || target === null ? undefined : target.spec
  if (typeof spec !== 'string' || spec === '') return undefined
  return typeof target.registry === 'string' && target.registry !== '' ? `${spec} (registry ${oneLine(target.registry)})` : spec
}

function versionsOf(entry) {
  return (Array.isArray(entry.versions) ? entry.versions : []).filter((version) => version !== null && typeof version === 'object')
}

function versionLine(version, entry, maxChars) {
  const source = version.source !== null && typeof version.source === 'object' && typeof version.source.type === 'string'
    ? version.source.type
    : 'source unknown'
  const parts = [
    oneLine(version.version) || 'unknown',
    isoDate(version.publishTimestamp),
    source,
    `DSH ${verdictTag(verdictOf(version))}`,
  ]
  const range = framework(version)
  if (range !== '') parts.push(range)
  const spec = installSpecOf(entry, version)
  if (spec !== undefined) parts.push(`install: ${spec}`)
  if (version.update === true) parts.push('updates installed copy')
  return clip(parts.join(' '), maxChars)
}

function rowMeta(entry, now, maxChars) {
  const version = typeof entry.defaultVersion === 'string'
    ? versionsOf(entry).find((candidate) => candidate.version === entry.defaultVersion)
    : undefined
  if (version === undefined) {
    return clip(`no compatible version ${installationLabel(entry)} install: none`, maxChars)
  }
  const parts = [
    oneLine(version.version) || 'unknown',
    isoDate(version.publishTimestamp),
    ageLabel(version.publishTimestamp, now),
    `DSH ${verdictTag(verdictOf(version))}`,
    installationLabel(entry),
  ]
  const spec = installSpecOf(entry, version)
  parts.push(spec === undefined ? 'install: none' : `install: ${spec}`)
  const count = versionsOf(entry).length
  if (count > 1) parts.push(`${count} versions`)
  return clip(parts.join(' '), maxChars)
}

/** Render one search page, or the merged pages of several indexes. */
export function formatSearch({ pages, keyword, category, offset, sort, now, maxChars }) {
  const lines = []
  const readable = pages.filter((page) => page !== null && typeof page === 'object' && page.result !== undefined && page.result !== null)
  const failed = pages.filter((page) => page !== null && typeof page === 'object' && page.error !== undefined)
  const shownKeyword = keyword === undefined ? '' : clip(oneLine(keyword), 80)
  const browsing = shownKeyword === ''
  const shownCategory = category === undefined ? undefined : clip(oneLine(category), 40)
  const titleOf = (page) => oneLine(textOf((page.index === null || page.index === undefined ? {} : page.index).title
    ?? (page.result === undefined ? undefined : page.result.title)))

  const labelOf = (page) => {
    const count = page.result.total
    return browsing
      ? `${count} plugin${count === 1 ? '' : 's'}`
      : `${count} match${count === 1 ? '' : 'es'} for "${shownKeyword}"`
  }
  const header = readable.length === 1
    ? `${titleOf(readable[0])}: ${labelOf(readable[0])}`
    : readable.map((page) => `${titleOf(page)}: ${labelOf(page)}`).join(', ')
  const shown = readable.reduce((total, page) => total + (Array.isArray(page.result.entries) ? page.result.entries.length : 0), 0)
  const categoryLabel = shownCategory === undefined ? '' : `, category=${shownCategory}`
  const sortLabel = sort === 'recent' ? ', newest first' : ''
  const offsetLabel = offset > 0 ? `, from ${offset}` : ''

  if (readable.length === 0 && failed.length === 0) return 'No plugin market index is configured.'

  if (readable.length > 0) {
    lines.push(`${header}${categoryLabel}${sortLabel}, showing ${shown}${offsetLabel}`)
  }
  for (const page of failed) {
    const title = titleOf(page)
    const url = page.index === null || page.index === undefined ? undefined : page.index.url
    lines.push(`index unavailable: ${title === '' ? (typeof url === 'string' ? url : 'configured index') : title} - ${clip(oneLine(String(page.error)), 240)}`)
  }

  let ordinal = 0
  for (const page of readable) {
    const entries = Array.isArray(page.result.entries) ? page.result.entries : []
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object') continue
      ordinal += 1
      const author = authorOf(entry)
      const metadata = entry.metadata !== null && typeof entry.metadata === 'object' ? entry.metadata : undefined
      const categoryId = metadata === undefined ? undefined : metadata.category
      const head = [oneLine(entry.name)]
      if (author !== undefined && oneLine(author) !== oneLine(entry.name)) head.push(oneLine(author))
      if (typeof categoryId === 'string' && categoryId !== '') head.push(oneLine(categoryId))
      lines.push(`${ordinal}. ${head.join(' ')}`)
      const purpose = textOf(entry.description)
      if (purpose !== '') lines.push(`   ${clip(purpose, maxChars)}`)
      lines.push(`   ${rowMeta(entry, now, maxChars)}`)
    }
  }

  const total = readable.reduce((sum, page) => sum + (Number.isFinite(page.result.total) ? page.result.total : 0), 0)

  if (ordinal === 0) {
    if (readable.length === 0) {
      lines.push('no configured index could be read; the market is unavailable')
      return lines.join('\n')
    }
    const first = readable[0].result
    if (total > 0 && offset > 0) {
      lines.push(`no rows at offset ${offset}; ${total} matches`)
      return lines.join('\n')
    }
    lines.push(browsing ? 'no plugins match these filters' : `no matches for "${shownKeyword}"`)
    const metadata = first.metadata !== null && typeof first.metadata === 'object' ? first.metadata : undefined
    const categories = metadata === undefined ? undefined : metadata.categories
    if (shownCategory !== undefined && categories !== undefined && categories !== null && categories[shownCategory] === undefined) {
      lines.push(`category "${shownCategory}" is not declared by this index`)
    }
    const ids = categories === undefined || categories === null ? [] : Object.keys(categories)
    if (ids.length > 0) lines.push(`categories: ${ids.map(oneLine).join(', ')}`)
    return lines.join('\n')
  }

  const remaining = Math.max(0, total - offset - shown)
  if (remaining > 0) lines.push(`more: ${remaining} matches, offset=${offset + shown}`)
  return lines.join('\n')
}

/** Full metadata for one entry. */
export function formatDetail({ entry, indexTitle, now, runtimeVersion, maxChars, focusVersion }) {
  const lines = []
  const name = oneLine(entry.name)
  const title = oneLine(textOf(entry.title))
  const author = oneLine(authorOf(entry))
  const titleIsLocation = author !== '' && (title === author || title.startsWith(`${author}/`))
  lines.push(title === '' || title === name || titleIsLocation ? name : `${name} (${title})`)

  const purpose = textOf(entry.description)
  if (purpose !== '') lines.push(clip(purpose, 600))

  const metadata = entry.metadata !== null && typeof entry.metadata === 'object' ? entry.metadata : {}
  if (typeof metadata.category === 'string' && metadata.category !== '') lines.push(`category: ${oneLine(metadata.category)}`)
  if (author !== '') lines.push(`author: ${author}`)
  const keywords = Array.isArray(metadata.keywords) ? metadata.keywords : []
  if (keywords.length > 0) lines.push(`keywords: ${keywords.map(oneLine).join(', ')}`)
  const labels = Array.isArray(metadata.labels) ? metadata.labels : []
  if (labels.length > 0) lines.push(`labels: ${labels.map(oneLine).join(', ')}`)

  if (typeof entry.repository === 'object' && entry.repository !== null && typeof entry.repository.url === 'string') {
    const directory = typeof entry.repository.directory === 'string' ? ` (${oneLine(entry.repository.directory)})` : ''
    lines.push(`repository: ${oneLine(entry.repository.url)}${directory}`)
  }
  if (typeof entry.homepage === 'string' && entry.homepage !== '') lines.push(`homepage: ${oneLine(entry.homepage)}`)
  if (indexTitle !== '') lines.push(`market: ${oneLine(indexTitle)}`)
  lines.push(`installed: ${installationLabel(entry)}`)

  const versions = [...versionsOf(entry)]
    .sort((left, right) => (right.publishTimestamp ?? 0) - (left.publishTimestamp ?? 0))
  const focus = focusVersion === undefined
    ? undefined
    : versions.find((version) => version.version === focusVersion)
  if (focusVersion !== undefined && focus === undefined) {
    lines.push(`version ${focusVersion} is not listed; listed: ${versions.map((version) => oneLine(version.version)).join(', ')}`)
  }

  const defaultVersion = entry.defaultVersion
  const defaultEntry = typeof defaultVersion === 'string'
    ? versions.find((version) => version.version === defaultVersion)
    : undefined
  if (defaultEntry !== undefined) {
    lines.push(`default: ${oneLine(defaultEntry.version)} (DSH ${verdictTag(verdictOf(defaultEntry))})`)
  } else {
    lines.push('default: none (no compatible version)')
  }

  const limit = 12
  lines.push(`versions: ${versions.length}`)
  for (const version of versions.slice(0, limit)) {
    lines.push(`  ${versionLine(version, entry, Math.max(maxChars, 260))}`)
  }
  if (versions.length > limit) lines.push(`  ... ${versions.length - limit} older versions not shown`)
  if (focus !== undefined && focus !== defaultEntry) {
    lines.push(`selected: ${oneLine(focus.version)} (DSH ${verdictTag(verdictOf(focus))})`)
  }

  const installed = focus ?? defaultEntry
  const spec = installed === undefined ? undefined : installSpecOf(entry, installed)
  if (spec !== undefined) lines.push(`install: ${spec}`)
  else if (installed === undefined) lines.push('install: none (no compatible version)')
  else lines.push('install: none (no install target for that version)')
  return lines.join('\n')
}

/** Compatibility report for one entry against the host or a requested version. */
export function formatCompatibility({ entry, indexTitle, targetVersion, runtimeVersion, maxChars }) {
  const lines = []
  const versions = [...versionsOf(entry)]
    .sort((left, right) => (right.publishTimestamp ?? 0) - (left.publishTimestamp ?? 0))
  const rows = versions.map((version) => ({
    version,
    verdict: targetVersion === undefined ? verdictOf(version) : localVerdict(version, targetVersion),
  }))
  const declarations = versions.filter((version) => framework(version) !== '')

  const status = rows.length === 0
    ? 'not listed'
    : rows.every((row) => row.verdict.status === 'undeclared')
      ? 'undeclared'
      : rows.some((row) => row.verdict.status === 'compatible')
        ? 'compatible'
        : rows.some((row) => row.verdict.status === 'undeclared')
          ? 'unverified'
          : rows.some((row) => row.verdict.status === 'incompatible')
            ? 'incompatible'
            : 'unverified'
  const checked = targetVersion === undefined
    ? runtimeVersion === undefined ? 'the running dsh, version unknown' : `dsh ${runtimeVersion}`
    : `dsh ${targetVersion}`
  lines.push(`${oneLine(entry.name)}: ${status} (${checked})`)

  if (indexTitle !== '') lines.push(`market: ${oneLine(indexTitle)}`)

  if (rows.length === 0) {
    lines.push('versions: 0')
    return lines.join('\n')
  }

  lines.push(`versions: ${rows.length}`)
  for (const row of rows.slice(0, 12)) {
    const range = row.verdict.range === '' ? '' : `, ${row.verdict.range}`
    lines.push(`  ${oneLine(row.version.version) || 'unknown'}: ${verdictTag(row.verdict)}${range}`)
  }
  if (rows.length > 12) lines.push(`  ... ${rows.length - 12} older versions not shown`)

  if (declarations.length === 0) {
    lines.push('note: no version declares engines.dsh; install is allowed but compatibility is unverified')
  } else if (rows.some((row) => row.verdict.status === 'undeclared')) {
    lines.push('note: some versions declare no requirement; their compatibility is unverified')
  }

  const installable = rows.filter((row) => row.verdict.status === 'compatible'
    || row.verdict.status === 'undeclared'
    || (row.verdict.status === 'incompatible' && row.verdict.exempted === true))
  const chosen = installable.length > 0
    ? installable.reduce((left, right) => (compareVersions(right.version.version, left.version.version) > 0 ? right : left))
    : undefined
  const spec = chosen === undefined ? undefined : installSpecOf(entry, chosen.version)
  lines.push(spec === undefined ? 'install: none (no version admits this dsh)' : `install: ${spec}`)
  return lines.join('\n')
}

function localVerdict(version, targetVersion) {
  const range = framework(version)
  if (range === '') return { status: 'undeclared', range: '' }
  const result = satisfies(targetVersion, range)
  if (!result.valid) return { status: 'unreadable', range }
  return { status: result.ok ? 'compatible' : 'incompatible', range }
}

/** Compare two version strings by SemVer precedence; malformed sorts last. */
export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null && b === null) return 0
  if (a === null) return -1
  if (b === null) return 1
  return compareSemver(a, b)
}


