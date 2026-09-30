#!/usr/bin/env node
import { main } from '../src/cli.js'

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code ?? 0
  })
  .catch((error) => {
    process.stderr.write(`\n[fatal] ${error?.stack ?? error}\n`)
    process.exitCode = 1
  })
