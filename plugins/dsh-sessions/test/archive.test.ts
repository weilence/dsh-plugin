import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { strToU8, unzipSync, zipSync, Zip, ZipPassThrough } from 'fflate'
import type { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore, FileAttachmentRef, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  SessionAlreadyExistsError,
  SessionPersistenceNotFoundError,
} from '@deepseek-ai/dsh-session-persistence'
import type { SessionHandle, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import {
  streamSessionLogZip,
  sessionLogExportDeps,
  readSessionLogText,
} from '@deepseek-ai/dsh-session-log-export'
import { exportArchive, importArchive, previewArchive } from '../src/archive.js'
import { MAX_ARCHIVE_BYTES, MAX_EXPANDED_BYTES, MAX_REQUEST_BYTES } from '../src/shared.js'

type Stored = { header: SessionHeader; events: SessionEvent[]; inheritedEventCount: SessionLogOffset }
const sha = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex')
const header = (id = 'root', extra: Record<string, unknown> = {}) => ({
  type: 'session',
  version: 4,
  id,
  createdAt: 1,
  cwd: 'C:\\source',
  isSeeded: false,
  delegationDepth: 0,
  ...extra,
})
const message = (content: unknown[] = [{ type: 'text', text: 'Hello' }]) => ({
  seq: 0,
  time: 1,
  type: 'user/message',
  data: { id: 'message', role: 'user', source: { kind: 'user' }, content },
  surfaceOp: 'append',
})
const jsonl = (id = 'root', rows: unknown[] = [message()], extra: Record<string, unknown> = {}) =>
  strToU8([header(id, extra), ...rows].map((value) => JSON.stringify(value)).join('\n') + '\n')
const archive = (entries: Record<string, Uint8Array> = {}) =>
  zipSync({ 'session.v4.jsonl': jsonl(), ...entries })

function fixture() {
  const stored = new Map<string, Stored>()
  const live = new Set<string>()
  const attached = new Set<string>()
  const binaries = new Map<string, Uint8Array>()
  let failCreate: string | undefined
  let failAppend: string | undefined
  let failAttach = false
  const handle = (entry: Stored, access: 'read' | 'write'): SessionHandle => ({
    id: entry.header.id,
    header: entry.header,
    inheritedEventCount: entry.inheritedEventCount,
    access,
    read: async () => ({ events: [...entry.events], eventState: 'shared-frozen' }),
    append: async (events) => {
      if (failAppend === entry.header.id) throw new Error('Disk quota exceeded')
      entry.events.push(...events)
    },
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    [Symbol.asyncDispose]: async () => {},
  })
  const persistence = {
    create: vi.fn(async (meta, options) => {
      if (failCreate === meta.id) throw new SessionAlreadyExistsError(meta.id)
      if (stored.has(meta.id)) throw new SessionAlreadyExistsError(meta.id)
      const entry = {
        header: meta,
        events: [],
        inheritedEventCount: options?.inheritedEventCount ?? SessionLogOffset(0),
      }
      stored.set(meta.id, entry)
      return handle(entry, 'write')
    }),
    open: vi.fn(async (id, access) => {
      const entry = stored.get(id)
      if (entry === undefined) throw new SessionPersistenceNotFoundError(id)
      return handle(entry, access)
    }),
  } satisfies Pick<SessionPersistence, 'create' | 'open'>
  const attachments = {
    validateImage: vi.fn(async () => {}),
    saveImage: vi.fn(async (input) => {
      const ref: ImageAttachmentRef = {
        attachmentId: AttachmentId(`sha256:${sha(input.data)}`),
        bytes: input.data.length,
        mediaType: input.mediaType,
        width: 1,
        height: 1,
        ...(input.name ? { name: input.name } : {}),
      }
      binaries.set(String(ref.attachmentId), input.data)
      return ref
    }),
    saveFileStream: vi.fn(async (input) => {
      const chunks: Uint8Array[] = []
      for await (const data of input.data) chunks.push(data)
      const bytes = Buffer.concat(chunks)
      const ref: FileAttachmentRef = {
        attachmentId: AttachmentId(`sha256:${sha(bytes)}`),
        bytes: bytes.length,
        name: input.name ?? 'file',
      }
      binaries.set(String(ref.attachmentId), bytes)
      return ref
    }),
    readImage: async (ref) => ({ ref, data: binaries.get(String(ref.attachmentId))! }),
    readFileStream: async function* (ref) {
      yield binaries.get(String(ref.attachmentId))!
    },
  } satisfies Pick<
    AttachmentStore,
    'validateImage' | 'saveImage' | 'saveFileStream' | 'readImage' | 'readFileStream'
  >
  const services = {
    sessionPersistence: persistence,
    sessions: {
      get: (id: string) => (live.has(id) ? {} : undefined),
      messageProjections: [],
      flush: vi.fn(async () => {}),
    },
    attachments,
    sessionQuery: {
      traceSession: async (id: string) => ({
        session: { header: stored.get(id)!.header },
        descendants: [...stored.values()]
          .filter((entry) => entry.header.origin === 'subagent')
          .map((entry) => ({ session: { header: entry.header }, descendants: [] })),
      }),
    },
    workspaceRegistry: {
      create: vi.fn(async () => ({
        attachSession: async (id: string) => {
          if (failAttach) throw new Error('Workspace update failed')
          attached.add(id)
        },
      })),
    },
  }
  const ctx = { ...services, get: (key: keyof typeof services) => services[key] } as unknown as Context
  return {
    ctx,
    stored,
    live,
    attached,
    binaries,
    persistence,
    attachments,
    sessions: services.sessions,
    failCreate: (id: string) => {
      failCreate = id
    },
    failAppend: (id: string) => {
      failAppend = id
    },
    failAttach: (value: boolean) => {
      failAttach = value
    },
  }
}

describe('official session archives', () => {
  let cwd: string
  beforeEach(async () => {
    cwd = await mkdtemp(join(tmpdir(), 'dsh-sessions-'))
  })
  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true })
  })

  it('roundtrips through the real official ZIP exporter and preserves events, ids and cwd mapping', async () => {
    const source = fixture()
    const bytes = archive()
    const preview = await previewArchive(source.ctx, bytes, cwd)
    expect(preview.sessions).toEqual([{ id: 'root', eventCount: 1, cwd: 'C:\\source', status: 'new' }])
    expect(preview.expected.sessions).toEqual({ root: null })
    expect(await importArchive(source.ctx, bytes, cwd, preview.expected)).toEqual({
      imported: ['root'],
      skipped: [],
      incomplete: [],
    })
    expect(source.stored.get('root')!.header.cwd).toBe(cwd)
    expect(source.attached.has('root')).toBe(true)
    const exported = await exportArchive(source.ctx, 'root')
    expect(Object.keys(unzipSync(exported))).toEqual(['session.v4.jsonl'])
    const target = fixture()
    const again = await previewArchive(target.ctx, exported, cwd)
    expect(await importArchive(target.ctx, exported, cwd, again.expected)).toEqual({
      imported: ['root'],
      skipped: [],
      incomplete: [],
    })
    expect(target.stored.get('root')).toEqual(source.stored.get('root'))
  })

  it('flushes live root and descendants before exporting valid committed prefixes', async () => {
    const f = fixture()
    const bytes = archive({
      'subagents/child/session.v4.jsonl': jsonl('child', [], { origin: 'subagent', parentSession: 'root' }),
    })
    const expected = (await previewArchive(f.ctx, bytes, cwd)).expected
    await importArchive(f.ctx, bytes, cwd, expected)
    f.live.add('root')
    f.live.add('child')
    const exported = await exportArchive(f.ctx, 'root')
    expect(f.sessions.flush).toHaveBeenCalledTimes(2)
    expect(Object.keys(unzipSync(exported))).toEqual(['session.v4.jsonl', 'subagents/child/session.v4.jsonl'])
    const target = fixture()
    expect((await previewArchive(target.ctx, exported, cwd)).sessions).toHaveLength(2)
  })

  it.each([{ parentSession: 'unrelated' }, { parentSession: 'child' }])(
    'rejects unrelated or cyclic descendant lineage before writing',
    async (extra) => {
      const f = fixture()
      await expect(
        previewArchive(
          f.ctx,
          archive({ 'subagents/child/session.v4.jsonl': jsonl('child', [], extra) }),
          cwd,
        ),
      ).rejects.toThrow(/后代|循环/)
      expect(f.persistence.create).not.toHaveBeenCalled()
    },
  )

  it('skips exact content and associates same sessions again', async () => {
    const f = fixture()
    const bytes = archive()
    await importArchive(f.ctx, bytes, cwd, (await previewArchive(f.ctx, bytes, cwd)).expected)
    const preview = await previewArchive(f.ctx, bytes, cwd)
    expect(preview.sessions[0]!.status).toBe('same')
    expect(preview.expected.sessions.root).toMatch(/^[a-f0-9]{64}$/)
    f.attached.clear()
    expect(await importArchive(f.ctx, bytes, cwd, preview.expected)).toEqual({
      imported: [],
      skipped: ['root'],
      incomplete: [],
    })
    expect(f.persistence.create).toHaveBeenCalledTimes(1)
    expect(f.attached.has('root')).toBe(true)
  })

  it('rejects any existing-diff for the entire batch before creation', async () => {
    const f = fixture()
    const original = archive()
    await importArchive(f.ctx, original, cwd, (await previewArchive(f.ctx, original, cwd)).expected)
    const changed = archive({
      'session.v4.jsonl': jsonl('root', [message([{ type: 'text', text: 'Changed' }])]),
      'subagents/new/session.v4.jsonl': jsonl('new', [], { origin: 'subagent', parentSession: 'root' }),
    })
    const preview = await previewArchive(f.ctx, changed, cwd)
    expect(preview.sessions[0]!.status).toBe('conflict')
    await expect(importArchive(f.ctx, changed, cwd, preview.expected)).rejects.toThrow('冲突')
    expect(f.stored.has('new')).toBe(false)
  })

  it('rejects facts changed after preview, even if the racer imported identical content', async () => {
    const f = fixture()
    const bytes = archive()
    const preview = await previewArchive(f.ctx, bytes, cwd)
    await importArchive(f.ctx, bytes, cwd, preview.expected)
    await expect(importArchive(f.ctx, bytes, cwd, preview.expected)).rejects.toThrow('预览后已发生变化')
  })

  it('binds confirmation to exact archive bytes, cwd and the entire session set', async () => {
    const f = fixture()
    const bytes = archive()
    const expected = (await previewArchive(f.ctx, bytes, cwd)).expected
    await expect(
      importArchive(f.ctx, archive({ 'session.v4.jsonl': jsonl('other') }), cwd, expected),
    ).rejects.toThrow('导入确认')
    await expect(importArchive(f.ctx, bytes, cwd, { ...expected, cwd: 'elsewhere' })).rejects.toThrow(
      '导入确认',
    )
    await expect(
      importArchive(f.ctx, bytes, cwd, { ...expected, sessions: { extra: null } }),
    ).rejects.toThrow('预览后已发生变化')
    expect(f.persistence.create).not.toHaveBeenCalled()
  })

  it('keeps official create as the final no-overwrite race guard', async () => {
    const f = fixture()
    const bytes = archive()
    const preview = await previewArchive(f.ctx, bytes, cwd)
    f.failCreate('root')
    expect(await importArchive(f.ctx, bytes, cwd, preview.expected)).toEqual({
      imported: [],
      skipped: [],
      incomplete: [],
      failure: { id: 'root', reason: 'session "root" already exists' },
    })
  })

  it('preserves seed cut and subagent metadata without attaching child chats', async () => {
    const f = fixture()
    const bytes = archive({
      'subagents/child/session.v4.jsonl': jsonl(
        'child',
        [message(), { seq: 1, time: 2, type: 'session/end-seed', data: { inherited: true } }],
        { isSeeded: true, parentSession: 'root', origin: 'subagent', delegationDepth: 1 },
      ),
    })
    const expected = (await previewArchive(f.ctx, bytes, cwd)).expected
    expect((await importArchive(f.ctx, bytes, cwd, expected)).imported).toEqual(['root', 'child'])
    expect(f.stored.get('child')!.inheritedEventCount).toBe(1)
    expect(f.stored.get('child')!.header.parentSession).toBe('root')
    expect([...f.attached]).toEqual(['root'])
    expect(Object.keys(unzipSync(await exportArchive(f.ctx, 'root')))).toContain(
      'subagents/child/session.v4.jsonl',
    )
  })

  it('prevalidates and saves referenced image/file bytes through official attachment APIs', async () => {
    const f = fixture()
    const imageData = strToU8('image fixture')
    const fileData = strToU8('file fixture')
    const image = {
      attachmentId: `sha256:${sha(imageData)}`,
      mediaType: 'image/png',
      bytes: imageData.length,
      width: 1,
      height: 1,
    }
    const file = { attachmentId: `sha256:${sha(fileData)}`, bytes: fileData.length, name: 'test.txt' }
    const bytes = archive({
      'session.v4.jsonl': jsonl('root', [
        message([
          { type: 'image', attachment: image },
          { type: 'file', attachment: file },
        ]),
      ]),
      [`media/${image.attachmentId}.png`]: imageData,
      [`files/${sha(fileData).slice(0, 2)}/${sha(fileData)}/test.txt`]: fileData,
    })
    const preview = await previewArchive(f.ctx, bytes, cwd)
    expect(f.attachments.saveImage).not.toHaveBeenCalled()
    expect(f.attachments.saveFileStream).not.toHaveBeenCalled()
    expect(await importArchive(f.ctx, bytes, cwd, preview.expected)).toEqual({
      imported: ['root'],
      skipped: [],
      incomplete: [],
    })
    expect(f.binaries.size).toBe(2)
    const target = fixture()
    const deps = sessionLogExportDeps(f.ctx)
    const root = await readSessionLogText(f.ctx.sessionPersistence, SessionId('root'))
    const stream = streamSessionLogZip(
      {
        ...deps,
        sessionQuery: deps.sessionQuery!,
        sessionPersistence: deps.sessionPersistence!,
        attachments: deps.attachments!,
      },
      root!,
      SessionId('root'),
      true,
      6,
      new AbortController().signal,
    )
    const exported = new Uint8Array(await new Response(stream).arrayBuffer())
    expect(Object.keys(unzipSync(exported))).toContain(`media/${image.attachmentId}.png`)
    const expected = (await previewArchive(target.ctx, exported, cwd)).expected
    expect((await importArchive(target.ctx, exported, cwd, expected)).imported).toEqual(['root'])
    expect(target.binaries).toEqual(f.binaries)
  })

  it.each(['missing', 'hash', 'length'])(
    'rejects %s attachments before saving or creating anything',
    async (kind) => {
      const f = fixture()
      const data = strToU8('expected')
      const ref = {
        attachmentId: `sha256:${sha(data)}`,
        bytes: kind === 'length' ? 1 : data.length,
        name: 'a',
      }
      const entries = {
        'session.v4.jsonl': jsonl('root', [message([{ type: 'file', attachment: ref }])]),
        ...(kind === 'missing'
          ? {}
          : {
              [`files/${sha(data).slice(0, 2)}/${sha(data)}/a`]: kind === 'hash' ? strToU8('tampered') : data,
            }),
      }
      await expect(previewArchive(f.ctx, archive(entries), cwd)).rejects.toThrow(/缺失|不一致/)
      expect(f.persistence.create).not.toHaveBeenCalled()
      expect(f.attachments.saveFileStream).not.toHaveBeenCalled()
    },
  )

  it('fails explicitly if image provider normalization changes identity', async () => {
    const f = fixture()
    const data = strToU8('image')
    const ref = {
      attachmentId: `sha256:${sha(data)}`,
      mediaType: 'image/png',
      bytes: data.length,
      width: 1,
      height: 1,
    }
    const bytes = archive({
      'session.v4.jsonl': jsonl('root', [message([{ type: 'image', attachment: ref }])]),
      [`media/sha256:${sha(data)}.png`]: data,
    })
    const expected = (await previewArchive(f.ctx, bytes, cwd)).expected
    f.attachments.saveImage.mockImplementationOnce(async (input) => ({
      attachmentId: AttachmentId('changed'),
      bytes: input.data.length,
      mediaType: input.mediaType,
      width: 1,
      height: 1,
    }))
    const result = await importArchive(f.ctx, bytes, cwd, expected)
    expect(result.failure!.reason).toContain('改变了归档字节')
    expect(f.persistence.create).not.toHaveBeenCalled()
  })

  it('uses full image admission before any archive writes', async () => {
    const f = fixture()
    const data = strToU8('invalid image')
    const ref = {
      attachmentId: `sha256:${sha(data)}`,
      mediaType: 'image/png',
      bytes: data.length,
      width: 1,
      height: 1,
    }
    f.attachments.validateImage.mockRejectedValueOnce(new Error('Raster decoder rejected image'))
    await expect(
      previewArchive(
        f.ctx,
        archive({
          'session.v4.jsonl': jsonl('root', [message([{ type: 'image', attachment: ref }])]),
          [`media/sha256:${sha(data)}.png`]: data,
        }),
        cwd,
      ),
    ).rejects.toThrow('Raster decoder')
    expect(f.persistence.create).not.toHaveBeenCalled()
  })

  it('reports complete and incomplete writes with the actual storage failure', async () => {
    const f = fixture()
    const bytes = archive({
      'subagents/child/session.v4.jsonl': jsonl('child', [], { origin: 'subagent', parentSession: 'root' }),
    })
    const expected = (await previewArchive(f.ctx, bytes, cwd)).expected
    f.failAppend('child')
    expect(await importArchive(f.ctx, bytes, cwd, expected)).toEqual({
      imported: ['root'],
      skipped: [],
      incomplete: ['child'],
      failure: { id: 'child', reason: 'Disk quota exceeded' },
    })
  })

  it('retries workspace association via same without duplicating persisted logs', async () => {
    const f = fixture()
    const bytes = archive()
    const expected = (await previewArchive(f.ctx, bytes, cwd)).expected
    f.failAttach(true)
    const result = await importArchive(f.ctx, bytes, cwd, expected)
    expect(result.imported).toEqual(['root'])
    expect(result.failure!.reason).toBe('Workspace update failed')
    f.failAttach(false)
    const retry = await previewArchive(f.ctx, bytes, cwd)
    expect((await importArchive(f.ctx, bytes, cwd, retry.expected)).skipped).toEqual(['root'])
    expect(f.attached.has('root')).toBe(true)
  })

  it.each(['../escape', '/absolute', 'a\\b', 'a/../b', 'C:/escape'])(
    'rejects ZIP path traversal %s',
    async (path) => {
      await expect(previewArchive(fixture().ctx, archive({ [path]: strToU8('evil') }), cwd)).rejects.toThrow(
        '路径不安全',
      )
    },
  )

  it('rejects unreferenced entries and duplicate session identities', async () => {
    await expect(previewArchive(fixture().ctx, archive({ extra: strToU8('data') }), cwd)).rejects.toThrow(
      '未被引用',
    )
    await expect(
      previewArchive(fixture().ctx, archive({ 'subagents/root/session.v4.jsonl': jsonl() }), cwd),
    ).rejects.toThrow('会话 ID 重复')
  })

  it('rejects corrupt ZIP data by CRC and rejects truncated archives', async () => {
    const bytes = zipSync({ 'session.v4.jsonl': jsonl() }, { level: 0 })
    const position = 30 + new DataView(bytes.buffer).getUint16(26, true)
    bytes[position + 10] ^= 1
    await expect(previewArchive(fixture().ctx, bytes, cwd)).rejects.toThrow('CRC')
    await expect(previewArchive(fixture().ctx, bytes.subarray(0, bytes.length - 3), cwd)).rejects.toThrow(
      '结束记录',
    )
  })

  it('rejects forged expanded sizes and zip bombs before allocating the claimed expansion', async () => {
    const bytes = archive()
    const view = new DataView(bytes.buffer)
    const central = view.getUint32(bytes.length - 6, true)
    view.setUint32(central + 24, MAX_EXPANDED_BYTES + 1, true)
    await expect(previewArchive(fixture().ctx, bytes, cwd)).rejects.toThrow('解压大小')
    const bomb = zipSync({ 'session.v4.jsonl': new Uint8Array(1024 * 1024) })
    const bombView = new DataView(bomb.buffer)
    const directory = bombView.getUint32(bomb.length - 6, true)
    bombView.setUint32(directory + 24, 1, true)
    bombView.setUint32(22, 1, true)
    await expect(previewArchive(fixture().ctx, bomb, cwd)).rejects.toThrow(/larger than|buffer|length/i)
  })

  it('checks compressed request and ZIP bounds before interpreting payloads', async () => {
    expect(MAX_REQUEST_BYTES).toBeGreaterThan(Math.ceil(MAX_ARCHIVE_BYTES / 3) * 4)
    await expect(previewArchive(fixture().ctx, new Uint8Array(MAX_ARCHIVE_BYTES + 1), cwd)).rejects.toThrow(
      '64 MiB',
    )
    const bytes = archive()
    new DataView(bytes.buffer).setUint32(bytes.length - 6, 0xffffff00, true)
    await expect(previewArchive(fixture().ctx, bytes, cwd)).rejects.toThrow('边界')
  })

  it.each([3, 5])('rejects noncurrent version %s', async (version) => {
    await expect(
      previewArchive(fixture().ctx, archive({ 'session.v4.jsonl': jsonl('root', [], { version }) }), cwd),
    ).rejects.toThrow('只支持当前 V4')
  })

  it('rejects duplicate ZIP names instead of silently choosing the last entry', async () => {
    const chunks: Uint8Array[] = []
    const zip = new Zip((_error, data) => {
      chunks.push(data)
    })
    for (let index = 0; index < 2; index++) {
      const entry = new ZipPassThrough('session.v4.jsonl')
      zip.add(entry)
      entry.push(jsonl(), true)
    }
    zip.end()
    await expect(previewArchive(fixture().ctx, Buffer.concat(chunks), cwd)).rejects.toThrow('条目重复')
  })

  it.each(['symlink', 'encrypted'])('rejects unsupported ZIP %s metadata', async (kind) => {
    const bytes = archive()
    const view = new DataView(bytes.buffer)
    const central = view.getUint32(bytes.length - 6, true)
    if (kind === 'symlink') view.setUint32(central + 38, (0xa1ff << 16) >>> 0, true)
    else view.setUint16(central + 8, view.getUint16(central + 8, true) | 1, true)
    await expect(previewArchive(fixture().ctx, bytes, cwd)).rejects.toThrow(/符号链接|加密/)
  })

  it('hard-limits entry, session and event counts before importing', async () => {
    const f = fixture()
    const entries = Object.fromEntries(
      Array.from({ length: 4096 }, (_, index) => [`extra-${index}`, new Uint8Array()]),
    )
    await expect(previewArchive(f.ctx, archive(entries), cwd)).rejects.toThrow('条目数量')
    const children = Object.fromEntries(
      Array.from({ length: 256 }, (_, index) => [
        `subagents/child-${index}/session.v4.jsonl`,
        jsonl(`child-${index}`, [], { parentSession: 'root' }),
      ]),
    )
    await expect(previewArchive(f.ctx, archive(children), cwd)).rejects.toThrow('会话数量')
    const rows = Array.from({ length: 100001 }, (_, seq) => ({
      seq,
      time: 1,
      type: 'custom',
      ignorable: true,
      data: {},
    }))
    await expect(
      previewArchive(f.ctx, archive({ 'session.v4.jsonl': jsonl('root', rows) }), cwd),
    ).rejects.toThrow('事件数量')
    expect(f.persistence.create).not.toHaveBeenCalled()
  })

  it('bounds official attachment streams during export even when compressed output stays tiny', async () => {
    const f = fixture()
    const data = strToU8('file')
    const ref = { attachmentId: `sha256:${sha(data)}`, bytes: data.length, name: 'a' }
    const bytes = archive({
      'session.v4.jsonl': jsonl('root', [message([{ type: 'file', attachment: ref }])]),
      [`files/${sha(data).slice(0, 2)}/${sha(data)}/a`]: data,
    })
    await importArchive(f.ctx, bytes, cwd, (await previewArchive(f.ctx, bytes, cwd)).expected)
    f.attachments.readFileStream = async function* () {
      const chunk = new Uint8Array(65536)
      for (let index = 0; index < 1025; index++) yield chunk
    }
    await expect(exportArchive(f.ctx, 'root')).rejects.toThrow('解压大小')
  })

  it('binds cwd confirmation to the canonical directory rather than a retargetable junction', async () => {
    const f = fixture()
    const first = join(cwd, 'first')
    const second = join(cwd, 'second')
    const link = join(cwd, 'link')
    await mkdir(first)
    await mkdir(second)
    await symlink(first, link, 'junction')
    const bytes = archive()
    const expected = (await previewArchive(f.ctx, bytes, link)).expected
    expect(expected.cwd).toBe(first)
    await unlink(link)
    await symlink(second, link, 'junction')
    await expect(importArchive(f.ctx, bytes, link, expected)).rejects.toThrow('导入确认')
    expect(f.persistence.create).not.toHaveBeenCalled()
  })

  it('requires own expected entries even for prototype-like session ids', async () => {
    const f = fixture()
    const bytes = archive({ 'session.v4.jsonl': jsonl('__proto__') })
    const expected = (await previewArchive(f.ctx, bytes, cwd)).expected
    expect(Object.hasOwn(expected.sessions, '__proto__')).toBe(true)
    expect(expected.sessions['__proto__']).toBeNull()
    expect((await importArchive(f.ctx, bytes, cwd, expected)).imported).toEqual(['__proto__'])
    expect(Object.getPrototypeOf(expected.sessions)).toBe(Object.prototype)
  })

  it('uses official lifecycle restoration instead of accepting merely contiguous events', async () => {
    const bytes = archive({
      'session.v4.jsonl': jsonl('root', [{ seq: 0, time: 1, type: 'step/end', data: { turn: 1, step: 1 } }]),
    })
    await expect(previewArchive(fixture().ctx, bytes, cwd)).rejects.toThrow()
  })

  it('refuses unknown required events but preserves opaque ignorable history', async () => {
    const row = { seq: 0, time: 1, type: 'future/event', data: { anything: true } }
    await expect(
      previewArchive(fixture().ctx, archive({ 'session.v4.jsonl': jsonl('root', [row]) }), cwd),
    ).rejects.toThrow()
    const f = fixture()
    const bytes = archive({ 'session.v4.jsonl': jsonl('root', [{ ...row, ignorable: true }]) })
    const expected = (await previewArchive(f.ctx, bytes, cwd)).expected
    expect((await importArchive(f.ctx, bytes, cwd, expected)).imported).toEqual(['root'])
  })

  it('never inherits cwd and refuses live ids at preview/import/export boundaries', async () => {
    const f = fixture()
    await expect(previewArchive(f.ctx, archive(), '')).rejects.toThrow('绝对目录')
    await expect(previewArchive(f.ctx, archive(), 'relative')).rejects.toThrow('绝对目录')
    await expect(previewArchive(f.ctx, archive(), join(cwd, 'missing'))).rejects.toThrow('ENOENT')
    const bytes = archive()
    const expected = (await previewArchive(f.ctx, bytes, cwd)).expected
    f.live.add('root')
    await expect(previewArchive(f.ctx, bytes, cwd)).rejects.toThrow('已加载')
    await expect(importArchive(f.ctx, bytes, cwd, expected)).rejects.toThrow('已加载')
  })
})
