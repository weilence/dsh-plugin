import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { effectiveNames, parseSkillFile, scanRoot, ROOT_RANK } from '../src/scan'
import type { ScannedSkill } from '../src/scan'

const tempDirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-skills-scan-'))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('parseSkillFile（官方校验规则）', () => {
  it('合法文件解析出完整条目', () => {
    const parsed = parseSkillFile(
      '---\nname: my-skill\ndescription: 做事\nwhenToUse: 需要时\ndisable-model-invocation: true\nuser-invocable: false\n---\n\n正文',
      'fallback',
    )
    expect(parsed.invalid).toBeUndefined()
    expect(parsed.name).toBe('my-skill')
    expect(parsed.description).toBe('做事')
    expect(parsed.whenToUse).toBe('需要时')
    expect(parsed.invocation).toEqual({ modelInvocable: false, userInvocable: false })
  })

  it('缺 frontmatter / 缺 name / 缺 description / 非法 name 均标记无效并回退文件名', () => {
    expect(parseSkillFile('没有 frontmatter 的正文', 'fallback').invalid).toContain('frontmatter')
    const noName = parseSkillFile('---\ndescription: d\n---\nbody', 'fallback')
    expect(noName.invalid).toContain('name')
    expect(noName.name).toBe('fallback')
    const noDesc = parseSkillFile('---\nname: a\n---\nbody', 'fallback')
    expect(noDesc.invalid).toContain('description')
    const badName = parseSkillFile('---\nname: Bad_Name\ndescription: d\n---\nbody', 'fallback')
    expect(badName.invalid).toContain('kebab-case')
  })

  it('旧版调用策略键整文件拒绝（与官方 parser 一致）', () => {
    const parsed = parseSkillFile('---\nname: a\ndescription: d\nuserInvocable: false\n---\nbody', 'fallback')
    expect(parsed.invalid).toContain('调用策略键')
  })
})

describe('scanRoot（发现规则）', () => {
  it('扁平文件与目录包都发现，非 .md 文件与无 SKILL.md 的目录跳过', async () => {
    const base = await tempDir()
    await writeFile(join(base, 'alpha.md'), '---\nname: alpha\ndescription: A\n---\nb', 'utf8')
    await mkdir(join(base, 'beta'))
    await writeFile(join(base, 'beta', 'SKILL.md'), '---\nname: beta\ndescription: B\n---\nb', 'utf8')
    await mkdir(join(base, 'gamma'))
    await writeFile(join(base, 'delta.txt'), 'x', 'utf8')
    const skills = await scanRoot({ id: 'user-dsh', path: base })
    expect(skills.map((skill) => skill.name).sort()).toEqual(['alpha', 'beta'])
    expect(skills.find((skill) => skill.name === 'beta')?.format).toBe('bundle')
    expect(skills.find((skill) => skill.name === 'alpha')?.format).toBe('flat')
  })

  it('user-dsh 根跳过 .system 子目录；无效文件以 invalid 行呈现', async () => {
    const base = await tempDir()
    await mkdir(join(base, '.system'))
    await writeFile(join(base, '.system', 'hidden.md'), '---\nname: hidden\ndescription: H\n---\nb', 'utf8')
    await writeFile(join(base, 'broken.md'), 'no frontmatter', 'utf8')
    const skills = await scanRoot({ id: 'user-dsh', path: base })
    expect(skills.map((skill) => skill.name)).toEqual(['broken'])
    expect(skills[0]?.invalid).toContain('frontmatter')
  })

  it('.system 目录包在 user-dsh 根跳过、在其他根照常发现', async () => {
    const base = await tempDir()
    await mkdir(join(base, '.system'))
    await writeFile(
      join(base, '.system', 'SKILL.md'),
      '---\nname: sys-bundle\ndescription: S\n---\nb',
      'utf8',
    )
    expect(await scanRoot({ id: 'user-dsh', path: base })).toEqual([])
    const other = await scanRoot({ id: 'project-dsh', path: base })
    expect(other.map((skill) => skill.name)).toEqual(['sys-bundle'])
    expect(other[0]?.format).toBe('bundle')
  })

  it('根不存在返回空数组', async () => {
    expect(await scanRoot({ id: 'user-dsh', path: join(await tempDir(), 'missing') })).toEqual([])
  })
})

describe('effectiveNames（同名遮蔽）', () => {
  const row = (name: string, source: ScannedSkill['source'], invalid?: string): ScannedSkill => ({
    name,
    description: 'd',
    invocation: { modelInvocable: true, userInvocable: true },
    source,
    path: `/${source}/${name}`,
    format: 'flat',
    ...(invalid !== undefined ? { invalid } : {}),
  })

  it('rank 低的来源胜出，无效条目不参与遮蔽判定', () => {
    const effective = effectiveNames([
      row('x', 'user-dsh'),
      row('x', 'project-dsh'),
      row('y', 'project-agents'),
      row('y', 'user-agents', '缺少 description'),
      row('z', 'user-agents', '缺少 description'),
    ])
    expect(effective.has('x')).toBe(true)
    // y 的 project-agents 条目合法 → 胜出；无效的 user-agents 不参与。
    expect(effective.has('y')).toBe(true)
    // z 只有无效条目 → 不生效。
    expect(effective.has('z')).toBe(false)
    // project-dsh(100) < user-dsh(400)：两者同名时只有前者胜。
    expect(ROOT_RANK['project-dsh']).toBeLessThan(ROOT_RANK['user-dsh'])
  })
})
