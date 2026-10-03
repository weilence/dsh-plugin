import { afterEach, describe, expect, it, vi } from 'vitest'
import { importFiles, type FileResult } from '../src/client/import'
import { IMPORT_PATH, MAX_ARCHIVE_BYTES } from '../src/shared'
import { messageText } from '../src/client/locales'
import { makeT } from './i18n'

const done = { imported: ['example'], skipped: [], incomplete: [] }
afterEach(() => vi.unstubAllGlobals())

describe('多份 ZIP 导入', () => {
  it('逐文件串行提交，每份使用同一明确目录和可信确认，不请求预览或导出', async () => {
    let active = 0
    const request = vi.fn(async (_path: string, _init: RequestInit) => {
      active++
      expect(active).toBe(1)
      await Promise.resolve()
      active--
      return Response.json(done)
    })
    vi.stubGlobal('fetch', request)
    const outcomes: FileResult[] = []
    const bytes = Uint8Array.from({ length: 65_537 }, (_, index) => index % 256)
    await importFiles(
      [new File([bytes], 'first.zip'), new File(['second'], 'second.zip')],
      '/target',
      (result) => outcomes.push(result),
    )
    expect(outcomes).toEqual([
      { filename: 'first.zip', result: done },
      { filename: 'second.zip', result: done },
    ])
    expect(request).toHaveBeenCalledTimes(2)
    for (const [path, init] of request.mock.calls) {
      expect(path).toBe(IMPORT_PATH)
      expect(init.method).toBe('POST')
      expect(init.headers).toMatchObject({ 'x-dsh-sessions': '1' })
      expect(JSON.parse(String(init.body))).toMatchObject({ cwd: '/target', trusted: true })
      expect(JSON.parse(String(init.body))).not.toHaveProperty('expected')
    }
    const body = JSON.parse(String(request.mock.calls[0]![1].body))
    expect(Buffer.from(body.archive, 'base64')).toEqual(Buffer.from(bytes))
  })

  it('HTTP 失败和部分导入结果保留实际原因，不妨碍后续 ZIP', async () => {
    const partial = {
      imported: ['saved'],
      skipped: ['same'],
      incomplete: ['broken'],
      failure: { reason: 'Disk quota exceeded' },
    }
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: 'ZIP CRC 校验失败' }, { status: 400 }))
      .mockResolvedValueOnce(Response.json(partial))
      .mockResolvedValueOnce(Response.json(done))
    vi.stubGlobal('fetch', request)
    const outcomes: FileResult[] = []
    await importFiles(
      ['bad', 'partial', 'good'].map((name) => new File([name], `${name}.zip`)),
      '/target',
      (result) => outcomes.push(result),
    )
    expect(outcomes).toEqual([
      { filename: 'bad.zip', error: { text: 'ZIP CRC 校验失败' } },
      { filename: 'partial.zip', result: partial },
      { filename: 'good.zip', result: done },
    ])
  })

  it('超限文件不读取、不发送，错误描述子随宿主语言变化', async () => {
    const arrayBuffer = vi.fn()
    const large = { name: 'large.zip', size: MAX_ARCHIVE_BYTES + 1, arrayBuffer } as unknown as File
    const request = vi.fn(async () => Response.json(done))
    vi.stubGlobal('fetch', request)
    const outcomes: FileResult[] = []
    await importFiles([large, new File(['valid'], 'valid.zip')], '/target', (result) => outcomes.push(result))
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledOnce()
    const first = outcomes[0]!
    if (!('error' in first)) throw new Error('缺少超限错误')
    expect(messageText(first.error, makeT())).toBe('ZIP 超过 64 MiB，无法导入。')
    expect(messageText(first.error, makeT('en'))).toBe('The ZIP exceeds the 64 MiB limit.')
    expect(outcomes[1]).toEqual({ filename: 'valid.zip', result: done })
  })

  it('文件读取失败保留具体原因，空选择不请求', async () => {
    const bad = new File(['bad'], 'unreadable.zip')
    vi.spyOn(bad, 'arrayBuffer').mockRejectedValue(new Error('File is no longer readable'))
    const request = vi.fn()
    vi.stubGlobal('fetch', request)
    const outcomes: FileResult[] = []
    await importFiles([bad], '/target', (result) => outcomes.push(result))
    await importFiles([], '/target', (result) => outcomes.push(result))
    expect(outcomes).toEqual([{ filename: 'unreadable.zip', error: { text: 'File is no longer readable' } }])
    expect(request).not.toHaveBeenCalled()
  })
})
