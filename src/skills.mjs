/**
 * 随包 Skill 安装：把 skills 目录下每个子目录里的 SKILL.md 复制到目标目录。
 * 与 serving / quantization 同构（install-skills 子命令）。
 *
 * 注意：注释里不要写 glob 形状的 "星号斜杠"，那会提前关闭块注释（本文件踩过一次）。
 */
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirp } from './util/fsx.mjs'

export async function listSkills() {
  const dir = new URL('../skills/', import.meta.url).pathname
  const names = await fs.readdir(dir).catch(() => [])
  return names
}

export async function installSkills({ dir = join(homedir(), '.dsh', 'skills') } = {}) {
  const src = new URL('../skills/', import.meta.url).pathname
  const names = await fs.readdir(src).catch(() => [])
  const installed = []
  for (const n of names) {
    const from = join(src, n, 'SKILL.md')
    const to = join(dir, `inference-tuning-${n}`, 'SKILL.md')
    // eslint-disable-next-line no-await-in-loop
    const raw = await fs.readFile(from, 'utf8').catch(() => null)
    if (!raw) continue
    // eslint-disable-next-line no-await-in-loop
    await mkdirp(join(dir, `inference-tuning-${n}`))
    // eslint-disable-next-line no-await-in-loop
    await fs.writeFile(to, raw, { mode: 0o644 })
    installed.push({ name: n, path: to, bytes: Buffer.byteLength(raw) })
  }
  return { dir, installed }
}
