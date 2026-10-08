import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { HttpError } from '@dsh-plugins/shared/http'

// 官方后端未向插件导出 encodeSegment；这里按其磁盘布局规则编码会话 id。
// 编码只为定位候选目录，删除前还有目录内容与官方 stat 双重核对，布局变化时 fail-closed。
export function encodeIdSegment(id: string): string {
  let out = ''
  for (let index = 0; index < id.length; index += 1) {
    const code = id.charCodeAt(index)
    const ch = String.fromCharCode(code)
    out +=
      ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch) ? ch : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * 在存储根目录下定位会话目录：`<root>/<项目目录>/<编码后的会话 id>`。
 * 目录必须存在且包含官方 v4 生成日志，否则显式拒绝，绝不猜测路径。
 */
export async function locateSessionDir(root: string, id: string): Promise<string> {
  let projects
  try {
    projects = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new HttpError(
        409,
        `会话存储根目录不存在：${root}。请在 dsh-sessions 配置 sessionsRoot 指向实际目录`,
      )
    }
    throw error
  }
  const target = encodeIdSegment(id)
  for (const project of projects) {
    if (!project.isDirectory()) continue
    const candidate = join(root, project.name, target)
    let info
    try {
      info = await stat(candidate)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (!info.isDirectory()) continue
    const entries = await readdir(candidate)
    if (!entries.some((name) => name.startsWith('session.v4.jsonl'))) {
      throw new HttpError(409, `目录 ${candidate} 不含官方 v4 会话日志，拒绝删除`)
    }
    return candidate
  }
  throw new HttpError(
    409,
    `未能在会话存储根目录 ${root} 下定位会话 ${id} 的目录。若存储根已自定义，请在 dsh-sessions 配置 sessionsRoot`,
  )
}
