import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileCandidates, sessionCandidates } from '../src/client/candidates.ts'
import type { SessionRowLike } from '../src/client/candidates.ts'

function row(id: string, displayTitle: string, over: Partial<SessionRowLike> = {}): SessionRowLike {
  return {
    id,
    displayTitle,
    cwd: '/w',
    running: false,
    blank: false,
    updatedAt: Number(id.slice(1)) || 0,
    ...over,
  }
}

describe('sessionCandidates', () => {
  it('excludes self and blank rows and matches titles case-insensitively', () => {
    const rows = [
      row('a1', 'Config 方案'),
      row('a2', 'config 相关'),
      row('a3', '无关会话'),
      row('a4', 'blank 会话', { blank: true }),
    ]
    const out = sessionCandidates(rows, 'a1', '/w', 'workspace', 'config', 20)
    assert.deepEqual(out.map(candidate => candidate.id), ['a2'])
  })

  it('workspace scope keeps same-cwd rows only', () => {
    const rows = [
      row('b1', '登录模块', { cwd: '/w', updatedAt: 5 }),
      row('b2', '登录模块二', { cwd: '/other', updatedAt: 9 }),
    ]
    const out = sessionCandidates(rows, 'self', '/w', 'workspace', '登录', 20)
    assert.deepEqual(out.map(candidate => candidate.id), ['b1'])
  })

  it('all scope ranks same-cwd > no-cwd > other-cwd', () => {
    const rows = [
      row('c1', '部署脚本', { cwd: '/else', updatedAt: 9 }),
      row('c2', '部署脚本二', { cwd: undefined, updatedAt: 8 }),
      row('c3', '部署脚本三', { cwd: '/w', updatedAt: 7 }),
    ]
    const out = sessionCandidates(rows, 'self', '/w', 'all', '部署', 20)
    assert.deepEqual(out.map(candidate => candidate.id), ['c3', 'c2', 'c1'])
  })

  it('ranks prefix matches above substring matches, then by recency', () => {
    const rows = [
      row('d1', 'middle-config-文件', { updatedAt: 1 }),
      row('d2', 'config-文件', { updatedAt: 2 }),
      row('d3', 'config-文件二', { updatedAt: 3 }),
    ]
    const out = sessionCandidates(rows, 'self', '/w', 'workspace', 'config', 20)
    assert.deepEqual(out.map(candidate => candidate.id), ['d3', 'd2', 'd1'])
  })

  it('returns the three most recent rows for an empty query with a 最近 badge', () => {
    const rows = [
      row('e1', '旧会话', { updatedAt: 1 }),
      row('e2', '中会话', { updatedAt: 2 }),
      row('e3', '新会话', { updatedAt: 3 }),
      row('e4', '最新会话', { updatedAt: 4 }),
    ]
    const out = sessionCandidates(rows, 'self', '/w', 'workspace', '', 20)
    assert.deepEqual(out.map(candidate => candidate.label), ['最新会话', '新会话', '中会话'])
    assert.ok(out.every(candidate => candidate.description?.includes('最近')))
  })

  it('keeps the empty-query recommendations inside the workspace scope', () => {
    const rows = [
      row('h1', '本工作区最近', { cwd: '/w', updatedAt: 5 }),
      row('h2', '其他工作区更新', { cwd: '/other', updatedAt: 9 }),
    ]
    const out = sessionCandidates(rows, 'self', '/w', 'workspace', '', 20)
    assert.deepEqual(out.map(candidate => candidate.id), ['h1'])
  })

  it('disambiguates duplicate titles with a short-id suffix', () => {
    const rows = [
      row('f-123456', '未命名', { updatedAt: 1 }),
      row('f-abcdef', '未命名', { updatedAt: 2 }),
    ]
    const out = sessionCandidates(rows, 'self', '/w', 'workspace', '未命名', 20)
    assert.deepEqual(out.map(candidate => candidate.label).sort(), ['未命名 · 123456', '未命名 · abcdef'])
  })

  it('badges running and subagent rows', () => {
    const rows = [
      row('g1', '运行中的子代理', { running: true, parentId: 'p', updatedAt: 1 }),
    ]
    const out = sessionCandidates(rows, 'self', '/w', 'workspace', '运行', 20)
    assert.equal(out[0]?.description, '运行中 · 子智能体')
  })
})

describe('fileCandidates', () => {
  const files = (rel: string, root = '主', abs = `/w/${rel}`) => ({ abs, rel, root })

  it('ranks path prefix above segment prefix and sorts shallower first, with basename labels', () => {
    const rows = [
      files('src/deep/config.ts'),
      files('config-tools/readme.md'),
      files('config.ts'),
    ]
    const out = fileCandidates(rows, 'config', 20)
    assert.deepEqual(out.map(candidate => candidate.name), ['config.ts · 主', 'readme.md', 'config.ts · src/deep'])
    assert.deepEqual(out.map(candidate => candidate.abs), ['/w/config.ts', '/w/config-tools/readme.md', '/w/src/deep/config.ts'])
  })

  it('normalizes Windows-style relative paths for scoring and descriptions', () => {
    const rows = [
      { abs: 'E:\\w\\src\\deep\\config.ts', rel: 'src\\deep\\config.ts', root: '主' },
      { abs: 'E:\\w\\config.ts', rel: 'config.ts', root: '主' },
    ]
    const out = fileCandidates(rows, 'config', 20)
    assert.deepEqual(out.map(candidate => candidate.name), ['config.ts · 主', 'config.ts · src/deep'])
    assert.deepEqual(out[1]?.description, 'src/deep/config.ts')
  })

  it('caps the result', () => {
    const rows = Array.from({ length: 10 }, (_, i) => files(`f${String(i).padStart(2, '0')}.ts`))
    assert.equal(fileCandidates(rows, 'f', 5).length, 5)
  })

  it('clusters primary-root rows before added roots', () => {
    const rows = [
      files('a.ts', 'lib', '/lib/a.ts'),
      files('a.ts', '主', '/w/a.ts'),
    ]
    const out = fileCandidates(rows, 'a', 20)
    assert.equal(out[0]?.abs, '/w/a.ts')
    assert.equal(out[0]?.name, 'a.ts · 主')
  })

  it('disambiguates duplicate basenames with the root alias when the directory is shared', () => {
    const rows = [
      files('same.ts', '主', '/w/same.ts'),
      files('same.ts', 'lib', '/lib/same.ts'),
    ]
    const out = fileCandidates(rows, 'same', 20)
    assert.deepEqual(out.map(candidate => candidate.name).sort(), ['same.ts · lib', 'same.ts · 主'])
    assert.ok(out.every(candidate => candidate.description?.includes('主') || candidate.description?.includes('lib')))
  })

  it('describes the full relative path and omits description for top-level single-root files', () => {
    const rows = [files('src/a.ts'), files('top.ts')]
    const out = fileCandidates(rows, '', 20)
    assert.equal(out[0]?.name, 'top.ts')
    assert.equal(out[0]?.description, undefined)
    assert.equal(out[1]?.name, 'a.ts')
    assert.equal(out[1]?.description, 'src/a.ts')
  })
})
