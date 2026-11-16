/**
 * The expectations below come from semver 7.8.6's
 * `satisfies(version, range, { includePrerelease: true })`, the exact call DSH
 * uses for `engines.dsh`. Regenerate them with the bundled semver, not by hand.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { parseVersion, satisfies, compare } from '../lib/semver.js'

const versions = ['0.2.2-rc.3', '0.2.1-rc.1', '0.2.1-rc.2', '0.2.0', '0.2.1', '0.3.0-0', '0.3.0-rc.1', '0.3.0', '1.0.0', '0.0.0-rc.1']

const truth = {
  '>=0.2.1-rc.1': [1, 1, 1, 0, 1, 1, 1, 1, 1, 0],
  '>=0.2.1-rc.2 <0.3.0-0': [1, 0, 1, 0, 1, 0, 0, 0, 0, 0],
  '>=0.2.1-rc.2 <0.3.0-0 || >=0.2.2-rc.1 <0.3.0-0': [1, 0, 1, 0, 1, 0, 0, 0, 0, 0],
  '>=0.2.0-rc.2 <0.3.0-0': [1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
  '>=0.2.1 <0.3.0': [1, 0, 0, 0, 1, 1, 1, 0, 0, 0],
  '^0.2.1': [1, 0, 0, 0, 1, 0, 0, 0, 0, 0],
  '~0.2.1': [1, 0, 0, 0, 1, 0, 0, 0, 0, 0],
  '0.2.x': [1, 1, 1, 1, 1, 0, 0, 0, 0, 0],
  '*': [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  '>=0.2.2-rc.1': [1, 0, 0, 0, 0, 1, 1, 1, 1, 0],
  '0.2.2-rc.3': [1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  '<=0.3.0': [1, 1, 1, 1, 1, 1, 1, 1, 0, 1],
  '0.1.0 - 0.2.0': [0, 0, 0, 1, 0, 0, 0, 0, 0, 0],
  '>0.2.1': [1, 0, 0, 0, 0, 1, 1, 1, 1, 0],
  '<0.2.2': [1, 1, 1, 1, 1, 0, 0, 0, 0, 1],
  '>=0.2.1-rc.4': [1, 0, 0, 0, 1, 1, 1, 1, 1, 0],
}

test('matches semver with includePrerelease for every known range', () => {
  for (const [range, expected] of Object.entries(truth)) {
    versions.forEach((version, index) => {
      const actual = satisfies(version, range)
      assert.equal(actual.valid, true, `${range} should be readable`)
      assert.equal(actual.ok, expected[index] === 1, `${range} <= ${version}`)
    })
  }
})

test('desugars partial comparisons and attachments the same way semver does', () => {
  const cases = [
    ['0.2.0-rc.1', '0.2', true],
    ['1.0.0-rc.1', '1.x', true],
    ['0.2.1-rc.0', '^0.2.1', false],
    ['0.2.1-rc.0', '~0.2.1', false],
    ['0.2.0-rc.1', '~0.2', true],
    ['0.2.1-rc.2', '>=0.2.1-rc.2', true],
    ['0.2.1-rc.1', '>=0.2.1-rc.2', false],
    ['0.2.2-rc.0', '>0.2.1', true],
    ['0.2.1-rc.0', '<=0.2.1', true],
    ['0.0.1', '^0.0.1', true],
    ['0.0.2', '^0.0.1', false],
    ['0.1.0', '^0.0.1', false],
    ['0.9.9', '^0', true],
    ['1.0.0', '^0', false],
    ['0.9.9', '~0', true],
    ['1.0.0', '~0', false],
    ['0.2.1', 'v0.2.1', true],
    ['0.2.1', '=0.2.1', true],
    ['0.3.0', '0.2.1 || 0.3.0', true],
    ['0.2.1', '>= 0.2.1', true],
    ['0.3.0-0', '<0.3.0-0', false],
    ['0.2.1-rc.3', '>=0.2.1-0 <0.3.0-0', true],
    ['0.2.9', '~0.2.3', true],
    ['0.2.3', '~0.2.3', true],
    ['0.2.2', '~0.2.3', false],
  ]
  for (const [version, range, expected] of cases) {
    assert.equal(satisfies(version, range).ok, expected, `${range} <= ${version}`)
  }
})

test('reports an empty, unreadable, or invalid range instead of guessing', () => {
  assert.deepEqual(satisfies('0.2.2', '').valid, false)
  assert.deepEqual(satisfies('0.2.2', '   ').valid, false)
  assert.deepEqual(satisfies('0.2.2', 'latest').valid, false)
  // semver reads `<` with no version as an invalid range, not as the empty set.
  assert.deepEqual(satisfies('0.2.2', '>=0.2.1 <').valid, false)
  assert.deepEqual(satisfies('not-a-version', '>=0.2.1').valid, false)
})

test('parses and orders versions including prereleases', () => {
  assert.equal(parseVersion('v0.2.2-rc.3+build.7').version, '0.2.2-rc.3')
  assert.equal(parseVersion('0.2'), null)
  assert.equal(compare(parseVersion('0.2.2-rc.10'), parseVersion('0.2.2-rc.9')), 1)
  assert.equal(compare(parseVersion('0.2.2'), parseVersion('0.2.2-rc.1')), 1)
  assert.equal(compare(parseVersion('0.2.2-1'), parseVersion('0.2.2-alpha')), -1)
})

test('rejects components the reference grammar rejects instead of matching or throwing', () => {
  const huge = '9'.repeat(400)
  const cases = [
    ['1.2.3', `>=${huge}`],
    ['1.2.3', '>=01.2.3'],
    ['01.2.3', '>=1.0.0'],
    ['1.2.3', '1.02.x'],
    [`${huge}.0.0`, '>=1.0.0'],
  ]
  for (const [version, range] of cases) {
    const result = satisfies(version, range)
    assert.equal(result.valid, false, `${range} <= ${version} must be unreadable`)
  }
  assert.equal(parseVersion('01.2.3'), null)
  assert.equal(parseVersion(`${huge}.0.0`), null)
})

test('matches semver for empty branches and wildcard comparators', () => {
  assert.equal(satisfies('1.2.3', '||').ok, true)
  assert.equal(satisfies('1.2.3', '1.2.3 ||').ok, true)
  assert.equal(satisfies('1.2.3', '>=*').ok, true)
  assert.equal(satisfies('1.2.3', '<*').ok, false)
  assert.equal(satisfies('1.2.3', '>*').ok, false)
})

test('arbitrary strings never throw', () => {
  const samples = [
    '', ' ', '>=', '^', '~', '||', '1.2.3.4', '1..2', '-1.2.3', '1.2.3-', 'x.y.z',
    '>= 1.2.3 <', '1.2.3 - ', '* | >1', '1.2.3+build+more', '01.02.03', 'v', 'v.',
    '>=1.2.3 ||', '|| >=1.2.3', '1.2.3 - 2.3.4 - 3.4.5', '~>', '^0.0.0',
  ]
  for (const sample of samples) {
    assert.doesNotThrow(() => satisfies('1.2.3', sample), `range ${JSON.stringify(sample)}`)
    assert.doesNotThrow(() => satisfies(sample, '>=1.0.0'), `version ${JSON.stringify(sample)}`)
  }
})
