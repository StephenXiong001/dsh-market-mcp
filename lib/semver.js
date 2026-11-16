/**
 * SemVer range matching for a plugin's declared engines.dsh.
 *
 * The harness checks compatibility with semver.satisfies(runtimeVersion, range,
 * { includePrerelease: true }) in its app-boot compatibility check. This module
 * implements the same subset without adding a dependency, so the tools can check
 * any harness version and not only the running one.
 *
 * Desugaring follows semver 7 (classes/range.js) with includePrerelease on:
 * caret, tilde, x-ranges, hyphen ranges, ||, and comparison sets. A range this
 * subset cannot read reports valid: false instead of guessing, so a check never
 * silently becomes compatible.
 */

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
const PARTIAL_RE = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?$/
const BUILD_RE = /\+[0-9A-Za-z.-]+/g

/**
 * Numeric component as SemVer defines it: no leading zero, and representable.
 * Returns null for a value the reference grammar rejects, so a malformed range
 * becomes unreadable instead of crashing or matching.
 */
function numericPart(digits) {
  if (!/^\d+$/.test(digits)) return null
  if (digits.length > 1 && digits.startsWith('0')) return null
  const value = Number(digits)
  return Number.isSafeInteger(value) ? value : null
}

/** Parse one exact version, returning null when it is not SemVer. */
export function parseVersion(text) {
  if (typeof text !== 'string') return null
  const match = VERSION_RE.exec(text.trim())
  if (match === null) return null
  const major = numericPart(match[1])
  const minor = numericPart(match[2])
  const patch = numericPart(match[3])
  if (major === null || minor === null || patch === null) return null
  return {
    version: `${major}.${minor}.${patch}${match[4] === undefined ? '' : `-${match[4]}`}`,
    major,
    minor,
    patch,
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function isNumeric(identifier) {
  return /^\d+$/.test(identifier)
}

function compareIdentifier(left, right) {
  const leftNumeric = isNumeric(left)
  const rightNumeric = isNumeric(right)
  if (leftNumeric && rightNumeric) return Number(left) - Number(right)
  if (leftNumeric) return -1
  if (rightNumeric) return 1
  return left < right ? -1 : left > right ? 1 : 0
}

/** Compare two parsed versions by SemVer precedence (build metadata ignored). */
export function compare(left, right) {
  const primary = left.major - right.major || left.minor - right.minor || left.patch - right.patch
  if (primary !== 0) return primary
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  const length = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index]
    const b = right.prerelease[index]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const order = compareIdentifier(a, b)
    if (order !== 0) return order
  }
  return 0
}

function filled(major, minor, patch, prerelease) {
  return parseVersion(`${major}.${minor}.${patch}${prerelease === undefined || prerelease === '' ? '' : `-${prerelease}`}`)
}

function lowerBound(major, minor, patch, prerelease) {
  return { op: '>=', version: filled(major, minor, patch, prerelease) }
}

function upperExclusive(major, minor, patch) {
  return { op: '<', version: filled(major, minor, patch, '0') }
}

function nullSet() {
  return { op: '<', version: filled(0, 0, 0, '0') }
}

/** Parse the version part of one comparator token; `*` and partials allowed. */
function parsePartial(text) {
  if (text === '' || text === '*' || text === 'x' || text === 'X') {
    return { major: undefined, minor: undefined, patch: undefined, prerelease: undefined }
  }
  const match = PARTIAL_RE.exec(text)
  if (match === null) return null
  const part = (value) => {
    if (value === undefined || value === 'x' || value === 'X' || value === '*') return undefined
    return numericPart(value)
  }
  const major = part(match[1])
  const minor = part(match[2])
  const patch = part(match[3])
  if (major === null || minor === null || patch === null) return null
  return {
    major,
    minor,
    patch,
    prerelease: match[4],
  }
}

/**
 * Turn one token (`^1.2`, `>=0.2.1-rc.2`, `1.2.x`, ...) into comparators.
 * Returns `null` for a token this subset cannot read.
 */
function desugar(token) {
  const operatorMatch = /^(>=|<=|>|<|=|\^|~>|~)(.*)$/.exec(token)
  let operator = ''
  let rest = token
  if (operatorMatch !== null) {
    operator = operatorMatch[1] === '~>' ? '~' : operatorMatch[1]
    rest = operatorMatch[2]
  }
  // A comparison operator needs a version; `>=*` is written with `*` explicitly.
  if (operator !== '' && rest === '') return null
  const partial = parsePartial(rest)
  if (partial === null) return null

  const { major, minor, patch, prerelease } = partial
  const xMajor = major === undefined
  const xMinor = xMajor || minor === undefined
  const xPatch = xMinor || patch === undefined

  // An `=` on an x-range behaves like no operator, matching semver.
  if (operator === '=' && xPatch) operator = ''

  if (operator === '^') {
    if (xMajor) return []
    if (xMinor) return [lowerBound(major, 0, 0, '0'), upperExclusive(major + 1, 0, 0)]
    if (xPatch) {
      return major === 0
        ? [lowerBound(0, minor, 0, '0'), upperExclusive(0, minor + 1, 0)]
        : [lowerBound(major, minor, 0, '0'), upperExclusive(major + 1, 0, 0)]
    }
    if (prerelease !== undefined) {
      if (major === 0) {
        return minor === 0
          ? [lowerBound(0, 0, patch, prerelease), upperExclusive(0, 0, patch + 1)]
          : [lowerBound(0, minor, patch, prerelease), upperExclusive(0, minor + 1, 0)]
      }
      return [lowerBound(major, minor, patch, prerelease), upperExclusive(major + 1, 0, 0)]
    }
    if (major === 0) {
      return minor === 0
        ? [lowerBound(0, 0, patch, ''), upperExclusive(0, 0, patch + 1)]
        : [lowerBound(0, minor, patch, ''), upperExclusive(0, minor + 1, 0)]
    }
    return [lowerBound(major, minor, patch, ''), upperExclusive(major + 1, 0, 0)]
  }

  if (operator === '~') {
    if (xMajor) return []
    if (xMinor) return [lowerBound(major, 0, 0, '0'), upperExclusive(major + 1, 0, 0)]
    if (xPatch) return [lowerBound(major, minor, 0, '0'), upperExclusive(major, minor + 1, 0)]
    if (prerelease !== undefined) {
      return [lowerBound(major, minor, patch, prerelease), upperExclusive(major, minor + 1, 0)]
    }
    return [lowerBound(major, minor, patch, ''), upperExclusive(major, minor + 1, 0)]
  }

  if ((operator === '>' || operator === '<') && xMajor) return [nullSet()]

  // `>=*`, `<=*` and similar admit every version; `=*` already lost its operator.
  if (operator !== '' && xMajor) return []

  if (operator !== '' && xPatch) {
    let nextMajor = major
    let nextMinor = xMinor ? 0 : minor
    if (operator === '>') {
      operator = '>='
      if (xMinor) {
        nextMajor = major + 1
        nextMinor = 0
      } else {
        nextMinor = minor + 1
      }
    } else if (operator === '<=') {
      operator = '<'
      if (xMinor) nextMajor = major + 1
      else nextMinor = minor + 1
    }
    return [{ op: operator, version: filled(nextMajor, nextMinor, 0, '0') }]
  }

  if (xMajor) return []
  if (xMinor) return [lowerBound(major, 0, 0, '0'), upperExclusive(major + 1, 0, 0)]
  if (xPatch) return [lowerBound(major, minor, 0, '0'), upperExclusive(major, minor + 1, 0)]

  return [{ op: operator === '' ? '=' : operator, version: filled(major, minor, patch, prerelease) }]
}

/** Rewrite `1.2.3 - 2.0.0` into comparable bounds, mirroring semver's hyphen rule. */
function hyphenBounds(text) {
  const match = /^(\S+)\s+-\s+(\S+)$/.exec(text)
  if (match === null) return null
  const from = parsePartial(match[1])
  const to = parsePartial(match[2])
  if (from === null || to === null || from.major === undefined) return null
  const lower = from.minor === undefined
    ? lowerBound(from.major, 0, 0, '0')
    : from.patch === undefined
      ? lowerBound(from.major, from.minor, 0, '0')
      : from.prerelease !== undefined
        ? lowerBound(from.major, from.minor, from.patch, from.prerelease)
        : lowerBound(from.major, from.minor, from.patch, '0')
  let upper = null
  if (to.major === undefined) upper = null
  else if (to.minor === undefined) upper = upperExclusive(to.major + 1, 0, 0)
  else if (to.patch === undefined) upper = upperExclusive(to.major, to.minor + 1, 0)
  else if (to.prerelease !== undefined) upper = { op: '<=', version: filled(to.major, to.minor, to.patch, to.prerelease) }
  else upper = upperExclusive(to.major, to.minor, to.patch + 1)
  return upper === null ? [lower] : [lower, upper]
}

/** Parse a range into alternatives of comparator lists; null when unreadable. */
function parseRange(text) {
  const normalized = text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(BUILD_RE, '')
    .replace(/(>=|<=|>|<|=|\^|~>|~) /g, '$1')
  const alternatives = []
  for (const rawAlternative of normalized.split('||')) {
    const alternative = rawAlternative.trim()
    const hyphen = hyphenBounds(alternative)
    const comparators = []
    const tokens = hyphen !== null ? [] : alternative.split(' ').filter((token) => token !== '')
    if (hyphen !== null) comparators.push(...hyphen)
    for (const token of tokens) {
      const desugared = desugar(token)
      if (desugared === null) return null
      comparators.push(...desugared)
    }
    alternatives.push(comparators)
  }
  return alternatives
}

function comparatorHolds(version, comparator) {
  if (comparator.op === '<' && comparator.version.version === '0.0.0-0') return false
  const order = compare(version, comparator.version)
  switch (comparator.op) {
    case '<': return order < 0
    case '<=': return order <= 0
    case '>': return order > 0
    case '>=': return order >= 0
    default: return order === 0
  }
}

/**
 * Decide whether `versionText` satisfies `rangeText` under DSH's rule.
 * `valid` is false for an empty or unreadable range, which the caller reports
 * as undeclared/unverified rather than compatible.
 */
export function satisfies(versionText, rangeText) {
  const version = parseVersion(versionText)
  if (version === null) return { ok: false, valid: false, reason: 'invalid-version' }
  if (typeof rangeText !== 'string' || rangeText.trim() === '') {
    return { ok: false, valid: false, reason: 'empty-range' }
  }
  const alternatives = parseRange(rangeText)
  if (alternatives === null) return { ok: false, valid: false, reason: 'unreadable-range' }
  const ok = alternatives.some((comparators) => comparators.every((comparator) => comparatorHolds(version, comparator)))
  return { ok, valid: true }
}
