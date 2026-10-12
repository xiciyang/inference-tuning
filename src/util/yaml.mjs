/**
 * 受限 YAML 子集 —— 只解析/发射本包自己写出的形状。
 *
 * 为什么不用现成 YAML 库：本包**零运行时依赖**是硬约束。
 * 为什么敢自己写：本包写出的 YAML 形状是封闭的（映射 / 序列 / 标量，缩进两空格），
 * 不需要锚点、多文档、折叠块这些特性。**遇到子集外的输入就响亮报错，不猜。**
 *
 * 与 inference-serving / inference-quantization 同一套口径：
 *   - 字符串一律双引号（避免 `yes`/`no`/`null`/数字样字符串被误读）
 *   - 非有限数字降级为字符串（否则会产出非法 YAML）
 *   - tab 缩进直接拒绝（YAML 规范禁止）
 *   - 支持 CJK 与流式集合（`[a, b]` / `{a: 1}`）
 */

const NULLISH = new Set(['null', '~', ''])

/**
 * 解析错误类型。
 *
 * 与 serving / quantization 的 `YamlError` **同名同形**（`name` / `message` / `line`）：
 * 三个包共读同一个状态根，错误类型不一致会让调用方没法统一处理
 * （例如 registry 读取失败时要不要回落到默认值）。
 */
export class YamlError extends Error {
  constructor(message, line) {
    super(line ? `${message} (line ${line})` : message)
    this.name = 'YamlError'
    this.line = line
  }
}

/** 读文件并解析；ENOENT 时返回 fallback（与兄弟包同形）。 */
export async function parseFile(fs, path, fallback = null) {
  try {
    return parse(await fs.readFile(path, 'utf8'))
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback
    throw err
  }
}

function indentOf(line) {
  const m = /^ */.exec(line)
  return m ? m[0].length : 0
}

function isBlank(line) {
  const t = line.trim()
  return t === '' || t.startsWith('#')
}

/** 解析行内流式集合：`[a, b]` 或 `{k: v, k2: v2}`。返回 undefined 表示"不是流式集合"。 */
function parseFlow(text) {
  const t = text.trim()
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim()
    if (inner === '') return []
    return splitTop(inner).map((x) => parseScalar(x.trim()))
  }
  if (t.startsWith('{') && t.endsWith('}')) {
    const inner = t.slice(1, -1).trim()
    const out = {}
    if (inner === '') return out
    for (const part of splitTop(inner)) {
      const i = indexOfTop(part, ':')
      if (i < 0) throw new Error(`流式映射项缺少冒号：${part}`)
      out[unquote(part.slice(0, i).trim())] = parseScalar(part.slice(i + 1).trim())
    }
    return out
  }
  return undefined
}

/** 按顶层逗号切分（忽略引号与嵌套括号内的逗号）。 */
function splitTop(s) {
  const out = []
  let depth = 0
  let quote = null
  let cur = ''
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]
    if (quote) {
      cur += c
      if (c === quote && s[i - 1] !== '\\') quote = null
      continue
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue }
    if (c === '[' || c === '{') depth += 1
    if (c === ']' || c === '}') depth -= 1
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue }
    cur += c
  }
  if (cur !== '' || out.length > 0) out.push(cur)
  return out
}

function indexOfTop(s, ch) {
  let depth = 0
  let quote = null
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]
    if (quote) { if (c === quote && s[i - 1] !== '\\') quote = null; continue }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '[' || c === '{') depth += 1
    if (c === ']' || c === '}') depth -= 1
    if (c === ':' && depth === 0) return i
  }
  return -1
}

function unquote(s) {
  const t = s.trim()
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n')
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'")
  return t
}

function parseScalar(raw) {
  const t = raw.trim()
  if (t === '') return null
  const flow = parseFlow(t)
  if (flow !== undefined) return flow
  if (t.startsWith('"') || t.startsWith("'")) return unquote(t)
  if (NULLISH.has(t)) return null
  if (t === 'true') return true
  if (t === 'false') return false
  if (/^-?\d+$/.test(t)) return Number(t)
  if (/^-?\d*\.\d+([eE][+-]?\d+)?$/.test(t)) return Number(t)
  return t
}

/** 解析受限 YAML 文本。 */
export function parse(text) {
  const rawLines = String(text ?? '').split('\n')
  for (const l of rawLines) {
    if (/^\t/.test(l) || /^ *\t/.test(l)) throw new Error('YAML 子集不接受 tab 缩进（规范禁止）')
  }
  const lines = rawLines
    .map((l, i) => ({ text: l.replace(/\s+$/, ''), no: i + 1 }))
    .filter((l) => !isBlank(l.text))

  let pos = 0
  function parseBlock(baseIndent) {
    if (pos >= lines.length) return null
    const first = lines[pos]
    if (indentOf(first.text) < baseIndent) return null
    const isSeq = /^-(\s|$)/.test(first.text.slice(indentOf(first.text)))
    return isSeq ? parseSeq(indentOf(first.text)) : parseMap(indentOf(first.text))
  }

  function parseSeq(indent) {
    const out = []
    while (pos < lines.length) {
      const { text } = lines[pos]
      const ind = indentOf(text)
      if (ind < indent) break
      if (ind > indent) throw new Error(`序列缩进不一致（第 ${lines[pos].no} 行）`)
      const body = text.slice(ind)
      if (!/^-(\s|$)/.test(body)) break
      const rest = body.replace(/^-\s?/, '')
      if (rest === '') {
        pos += 1
        out.push(parseBlock(indent + 1))
        continue
      }
      const colon = indexOfTop(rest, ':')
      if (colon >= 0) {
        // `- key: value` —— 首个键与 `-` 同行，其余键在更深缩进
        const obj = {}
        const k = unquote(rest.slice(0, colon))
        const v = rest.slice(colon + 1).trim()
        obj[k] = v === '' ? null : parseScalar(v)
        pos += 1
        while (pos < lines.length) {
          const nx = lines[pos]
          const nInd = indentOf(nx.text)
          if (nInd <= indent) break
          const nBody = nx.text.slice(nInd)
          if (/^-(\s|$)/.test(nBody)) break
          const ci = indexOfTop(nBody, ':')
          if (ci < 0) throw new Error(`映射项缺少冒号（第 ${nx.no} 行）`)
          const nk = unquote(nBody.slice(0, ci))
          const nv = nBody.slice(ci + 1).trim()
          if (nv === '') {
            pos += 1
            obj[nk] = parseBlock(nInd + 1)
          } else {
            obj[nk] = parseScalar(nv)
            pos += 1
          }
        }
        out.push(obj)
      } else {
        out.push(parseScalar(rest))
        pos += 1
      }
    }
    return out
  }

  function parseMap(indent) {
    const out = {}
    while (pos < lines.length) {
      const { text } = lines[pos]
      const ind = indentOf(text)
      if (ind < indent) break
      if (ind > indent) throw new Error(`映射缩进不一致（第 ${lines[pos].no} 行）`)
      const body = text.slice(ind)
      if (/^-(\s|$)/.test(body)) break
      const colon = indexOfTop(body, ':')
      if (colon < 0) throw new Error(`映射项缺少冒号（第 ${lines[pos].no} 行）：${body}`)
      const k = unquote(body.slice(0, colon))
      const v = body.slice(colon + 1).trim()
      if (v === '') {
        pos += 1
        out[k] = parseBlock(indent + 1)
      } else {
        out[k] = parseScalar(v)
        pos += 1
      }
    }
    return out
  }

  if (lines.length === 0) return null
  return parseBlock(0)
}

function emitScalar(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return `"${String(v)}"`
    return String(v)
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]'
    return `[${v.map((x) => emitScalar(x)).join(', ')}]`
  }
  if (typeof v === 'object') {
    const keys = Object.keys(v)
    if (keys.length === 0) return '{}'
    return `{${keys.map((k) => `${emitKey(k)}: ${emitScalar(v[k])}`).join(', ')}}`
  }
  return `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`
}

/**
 * 键的发射形态 —— **与 serving / quantization 对齐**。
 *
 * 本包曾经无条件给键加引号，而另两个包发裸键、且只认裸键：
 * 于是 `tuning-registry.yaml` 对它们**完全不可读**（真机实测的 `YamlError`）。
 * `~/.ai-infra` 名义上是三个包共享的状态根，实际成了单向门。
 *
 * 现在改成：**安全就用裸键**（与兄弟包的 writer 同形），只在键里含空格/引号等
 * 特殊字符时才加引号。两边 parser 都接受两种形态（见各自 KEY_RE），所以
 * 旧文件照样读得回来，不做一次性迁移。
 */
const BARE_KEY_RE = /^[A-Za-z0-9_.\-/]+$/
function emitKey(k) {
  const s = String(k)
  return BARE_KEY_RE.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`
}

/**
 * 空容器必须**行内发射**（`[]` / `{}`）。
 * 否则会写成
 *     "empty":
 *       []
 * 下一行既不是映射项也没有冒号，解析器只能报错 —— 实测踩到过。
 */
function isScalarLike(v) {
  if (v === null || typeof v !== 'object') return true
  if (Array.isArray(v)) return v.length === 0
  return Object.keys(v).length === 0
}

/** 序列化为受限 YAML（字符串一律双引号）。 */
export function stringify(value, { indent = 0 } = {}) {
  const pad = ' '.repeat(indent)
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`
    return value.map((item) => {
      if (isScalarLike(item) || Array.isArray(item)) {
        return `${pad}- ${emitScalar(item)}`
      }
      const keys = Object.keys(item)
      if (keys.length === 0) return `${pad}- {}`
      const [first, ...rest] = keys
      const head = `${pad}- ${emitKey(first)}: ${isScalarLike(item[first]) ? emitScalar(item[first]) : ''}`
      const headBlock = isScalarLike(item[first]) ? head : `${head}\n${stringify(item[first], { indent: indent + 4 })}`
      const tail = rest.map((k) => {
        const v = item[k]
        if (isScalarLike(v)) return `${' '.repeat(indent + 2)}${emitKey(k)}: ${emitScalar(v)}`
        return `${' '.repeat(indent + 2)}${emitKey(k)}:\n${stringify(v, { indent: indent + 4 })}`
      }).join('\n')
      return tail ? `${headBlock}\n${tail}` : headBlock
    }).join('\n')
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value)
    if (keys.length === 0) return `${pad}{}`
    return keys.map((k) => {
      const v = value[k]
      if (isScalarLike(v)) return `${pad}${emitKey(k)}: ${emitScalar(v)}`
      return `${pad}${emitKey(k)}:\n${stringify(v, { indent: indent + 2 })}`
    }).join('\n')
  }
  return `${pad}${emitScalar(value)}`
}
