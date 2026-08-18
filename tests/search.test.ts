import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join, sep } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  DEFAULT_EXCLUDES,
  buildSearchArgv,
  escapeGlobQuery,
  isPathUnder,
  resolveRoots,
  toAbsolutePath,
  toDisplayPath,
  toFileView,
} from '../src/search.ts'
import type { AddDirRegistryLike } from '../src/search.ts'

describe('escapeGlobQuery', () => {
  it('escapes ripgrep glob metacharacters', () => {
    assert.equal(escapeGlobQuery('a*b'), 'a\\*b')
    assert.equal(escapeGlobQuery('a{b,c}'), 'a\\{b\\,c\\}')
    assert.equal(escapeGlobQuery('a,b'), 'a\\,b')
    assert.equal(escapeGlobQuery('[x]?\\'), '\\[x\\]\\?\\\\')
  })

  it('leaves ordinary query text untouched', () => {
    assert.equal(escapeGlobQuery('config.ts'), 'config.ts')
    assert.equal(escapeGlobQuery('src/config'), 'src/config')
  })
})

describe('buildSearchArgv', () => {
  it('carries the core glob discipline and a case-insensitive any-segment pattern', () => {
    const argv = buildSearchArgv('conf', [])
    assert.ok(argv.includes('--files'))
    assert.ok(argv.includes('--hidden'))
    assert.ok(argv.includes('--no-ignore'))
    assert.ok(argv.includes('--sort=modified'))
    assert.ok(argv.includes('--iglob={**/*conf*,**/*conf*/**}'))
    assert.ok(buildSearchArgv('a,b', []).includes('--iglob={**/*a\\,b*,**/*a\\,b*/**}'))
    assert.equal(argv.at(-1), '--')
  })

  it('excludes VCS, default, and extra directory names with the double-negated form', () => {
    const argv = buildSearchArgv('x', ['vendor'])
    for (const name of [...DEFAULT_EXCLUDES, 'vendor', '.git']) {
      assert.ok(argv.includes(`--glob=!**/${name}`), `missing bare exclude for ${name}`)
      assert.ok(argv.includes(`--glob=!**/${name}/**`), `missing nested exclude for ${name}`)
    }
  })
})

describe('isPathUnder', () => {
  it('accepts the root itself and descendants, rejects siblings and prefix traps', () => {
    assert.equal(isPathUnder('/a/b', '/a/b'), true)
    assert.equal(isPathUnder('/a/b', '/a/b/c.ts'), true)
    assert.equal(isPathUnder('/a/b', '/a/bc.ts'), false)
    assert.equal(isPathUnder('/a/b', '/a'), false)
  })
})

describe('toDisplayPath', () => {
  it('renders workspace-relative paths and passes outsiders through', () => {
    assert.equal(toDisplayPath('/w', '/w/src/a.ts'), `src${sep}a.ts`)
    assert.equal(toDisplayPath('/w', '/elsewhere/a.ts'), '/elsewhere/a.ts')
  })
})

describe('toAbsolutePath', () => {
  it('joins relative ripgrep output against the workdir, keeps absolute lines', () => {
    assert.equal(toAbsolutePath('src/a.ts', '/w'), join('/w', 'src/a.ts'))
    assert.equal(toAbsolutePath('/else/a.ts', '/w'), '/else/a.ts')
  })
})

describe('toFileView', () => {
  it('labels primary-root files 主 and added-root files by basename', () => {
    const roots = ['/w', '/lib']
    assert.deepEqual(toFileView(roots, '/w/src/a.ts'), { abs: '/w/src/a.ts', rel: `src${sep}a.ts`, root: '主' })
    assert.deepEqual(toFileView(roots, '/lib/a.ts'), { abs: '/lib/a.ts', rel: 'a.ts', root: 'lib' })
    assert.deepEqual(toFileView(roots, '/else/a.ts'), { abs: '/else/a.ts', rel: '/else/a.ts', root: '其他' })
  })
})

describe('resolveRoots', () => {
  it('returns the primary directory alone without a registry', () => {
    const ctx = new Context()
    assert.deepEqual(resolveRoots(ctx, '/w', true), ['/w'])
  })

  it('respects includeAddedDirs=false', () => {
    const ctx = new Context()
    const registry: AddDirRegistryLike = {
      byCwd: () => ({ record: { dirs: ['/lib'] } }),
      statusOf: () => new Map([['/lib', 'ok']]),
    }
    ctx.provide('addDirRegistry', registry)
    assert.deepEqual(resolveRoots(ctx, '/w', false), ['/w'])
  })

  it('appends added directories with live ok status, skipping stale ones', () => {
    const ctx = new Context()
    const registry: AddDirRegistryLike = {
      byCwd: () => ({ record: { dirs: ['/lib', '/gone'] } }),
      statusOf: () => new Map([['/lib', 'ok'], ['/gone', 'missing']]),
    }
    ctx.provide('addDirRegistry', registry)
    assert.deepEqual(resolveRoots(ctx, '/w', true), ['/w', '/lib'])
  })

  it('returns the primary alone when the cwd has no record', () => {
    const ctx = new Context()
    const registry: AddDirRegistryLike = {
      byCwd: () => undefined,
      statusOf: () => new Map(),
    }
    ctx.provide('addDirRegistry', registry)
    assert.deepEqual(resolveRoots(ctx, '/w', true), ['/w'])
  })
})
