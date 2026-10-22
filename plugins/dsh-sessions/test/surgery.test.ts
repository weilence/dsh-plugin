import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { zstdCompress } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HttpError } from '@dsh-plugins/shared/http'
import {
  assertSessionDirectory,
  assertSessionId,
  canonicalLogName,
  encodeArtifactBytes,
  encodeIdSegment,
  encodeProjectKey,
  locateSessionArtifact,
  readSessionArtifactFile,
  replaceSessionFile,
} from '../src/surgery'

const compress = promisify(zstdCompress)

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-sessions-surgery-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('路径编码与文件名解析', () => {
  it('编码对齐官方 encodeSegment 与 projectKey', () => {
    expect(encodeIdSegment('abc-123')).toBe('abc-123')
    expect(encodeIdSegment('a:b/c')).toBe('a~003Ab~002Fc')
    expect(encodeIdSegment('.')).toBe('~002E')
    expect(encodeIdSegment('..')).toBe('~002E~002E')
    expect(encodeProjectKey('C:\\Users\\luo\\code')).toBe('--C-Users-luo-code--')
    expect(encodeProjectKey('/home/luo/code')).toBe('--home-luo-code--')
    expect(encodeProjectKey('C:\\')).toBe('--C---')
    expect(encodeProjectKey('')).toBe('--root--')
    expect(encodeProjectKey('X'.repeat(400)).length).toBeLessThanOrEqual(255)
  })

  it('规范生成名解析与官方口径一致', () => {
    expect(canonicalLogName('session.v4.jsonl.zstd')).toEqual({ version: 4, zstd: true })
    expect(canonicalLogName('session.jsonl')).toEqual({ version: 0, zstd: false })
    expect(canonicalLogName('session.v2.jsonl')).toEqual({ version: 2, zstd: false })
    expect(canonicalLogName('session.v0.jsonl')).toBeUndefined()
    expect(canonicalLogName('session.V4.jsonl')).toBeUndefined()
    expect(canonicalLogName('session.v04.jsonl')).toBeUndefined()
    expect(canonicalLogName('session.v4.jsonl.zstd.bak')).toBeUndefined()
    expect(canonicalLogName('notes.txt')).toBeUndefined()
  })

  it('会话 id 校验拒绝路径片段与控制字符', () => {
    expect(assertSessionId('session-1')).toBe('session-1')
    for (const bad of ['', ' ', '.', '..', 'a/b', 'a\\b', 'a\0b', 'a<b', 'a|b', 'a*', 'a.']) {
      expect(() => assertSessionId(bad)).toThrow(HttpError)
    }
  })
})

describe('工件定位与目录边界', () => {
  it('现扫定位任意代数工件，取数值最高的规范名', async () => {
    const dir = join(root, '--C-proj--', encodeIdSegment('s1'))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.v2.jsonl'), 'old')
    await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'new')
    await expect(locateSessionArtifact(root, 's1')).resolves.toMatchObject({
      dir,
      filename: 'session.v4.jsonl.zstd',
      version: 4,
      zstd: true,
    })
  })

  it('只含非规范文件的目录视为此处无会话', async () => {
    const dir = join(root, '--C-proj--', encodeIdSegment('s1'))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'session.v4.jsonl.zstd.abc123.bak'), 'hidden')
    await expect(locateSessionArtifact(root, 's1')).rejects.toThrow('未能在会话存储根目录')
  })

  it('存储根缺失时显式提示 sessionsRoot', async () => {
    await expect(locateSessionArtifact(join(root, 'missing'), 's1')).rejects.toThrow('sessionsRoot')
  })

  it('目录边界校验拒绝两层之外与符号链接', async () => {
    const dir = join(root, '--C-proj--', encodeIdSegment('s1'))
    await mkdir(dir, { recursive: true })
    await expect(assertSessionDirectory(root, dir, 's1')).resolves.toBeUndefined()
    await expect(assertSessionDirectory(root, join(dir, 'nested'), 's1')).rejects.toThrow('超出允许范围')
    await expect(
      assertSessionDirectory(root, join(root, '--other--', encodeIdSegment('s1')), 's1'),
    ).rejects.toThrow('ENOENT')
    const linked = join(root, '--link--')
    const { symlink } = await import('node:fs/promises')
    await symlink(join(root, '--C-proj--'), linked)
    await expect(assertSessionDirectory(root, join(linked, encodeIdSegment('s1')), 's1')).rejects.toThrow(
      '符号链接',
    )
  })
})

describe('工件读取与重编码', () => {
  const headerLine = JSON.stringify({ type: 'session', version: 4, id: 's1', cwd: 'C:\\old' })

  it('纯文本工件全量读取', async () => {
    const path = join(root, 'session.v4.jsonl')
    await writeFile(path, `${headerLine}\n{"type":"x"}\n`)
    await expect(readSessionArtifactFile(path, false)).resolves.toMatchObject({
      header: { id: 's1', cwd: 'C:\\old' },
      bodyText: '{"type":"x"}\n',
    })
  })

  it('不完整尾行拒绝改写', async () => {
    const path = join(root, 'session.v4.jsonl')
    await writeFile(path, `${headerLine}\n{"type":"x"}`)
    await expect(readSessionArtifactFile(path, false)).rejects.toThrow('不完整的尾行')
  })

  it('头行缺失或损坏拒绝', async () => {
    await writeFile(join(root, 'a.jsonl'), '{"broken"\n')
    await expect(readSessionArtifactFile(join(root, 'a.jsonl'), false)).rejects.toThrow('头行无法解析')
    await writeFile(join(root, 'b.jsonl'), '{"broken"')
    await expect(readSessionArtifactFile(join(root, 'b.jsonl'), false)).rejects.toThrow('缺少头行')
    await writeFile(join(root, 'c.jsonl'), '')
    await expect(readSessionArtifactFile(join(root, 'c.jsonl'), false)).rejects.toThrow('缺少头行')
  })

  it('zstd 工件按帧解码，截断尾帧拒绝改写', async () => {
    const body = JSON.stringify({ type: 'x' })
    const frames = Buffer.concat([
      await compress(Buffer.from(`${headerLine}\n`)),
      await compress(Buffer.from(`${body}\n`)),
    ])
    const path = join(root, 'session.v4.jsonl.zstd')
    await writeFile(path, frames)
    await expect(readSessionArtifactFile(path, true)).resolves.toMatchObject({
      header: { id: 's1' },
      bodyText: `${body}\n`,
    })
    await writeFile(path, frames.subarray(0, frames.length - 3))
    await expect(readSessionArtifactFile(path, true)).rejects.toThrow('截断的 Zstd 帧')
  })

  it('重编码保持头行独占第一帧，与读取往返一致', async () => {
    const bytes = await encodeArtifactBytes(headerLine, '{"type":"x"}\n', true)
    const path = join(root, 'session.v4.jsonl.zstd')
    await writeFile(path, bytes)
    const decoded = await readSessionArtifactFile(path, true)
    expect(decoded.headerText).toBe(headerLine)
    expect(decoded.bodyText).toBe('{"type":"x"}\n')
    const plain = await encodeArtifactBytes(headerLine, '{"type":"x"}\n', false)
    expect(plain.toString('utf8')).toBe(`${headerLine}\n{"type":"x"}\n`)
  })
})

describe('replaceSessionFile 三段式', () => {
  it('成功发布后清理备份', async () => {
    const path = join(root, 'session.v4.jsonl')
    await writeFile(path, 'old')
    await expect(replaceSessionFile(path, Buffer.from('new'))).resolves.toEqual({})
    await expect(readFile(path, 'utf8')).resolves.toBe('new')
  })

  it('目标缺失时备份失败显式拒绝且不产生新文件', async () => {
    const path = join(root, 'missing.jsonl')
    await expect(replaceSessionFile(path, Buffer.from('new'))).rejects.toThrow()
    await expect(readFile(join(root, 'missing.jsonl'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
