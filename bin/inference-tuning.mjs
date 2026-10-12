#!/usr/bin/env node
import { main } from '../src/cli.mjs'

main(process.argv.slice(2)).then((code) => process.exit(code ?? 0)).catch((err) => {
  process.stderr.write(`内部错误：${err?.stack ?? err}\n`)
  process.exit(1)
})
