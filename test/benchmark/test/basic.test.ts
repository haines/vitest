import type { FormattedBenchmarkReport } from 'vitest/src/node/reporters/benchmark/table/index.js'
import fs from 'node:fs'
import * as pathe from 'pathe'
import { expect, it } from 'vitest'
import { runVitest } from '../../test-utils'

it('basic', { timeout: 60_000 }, async () => {
  const root = pathe.join(import.meta.dirname, '../fixtures/basic')
  const benchFile = pathe.join(root, 'bench.json')
  fs.rmSync(benchFile, { force: true })

  const result = await runVitest({
    root,
    allowOnly: true,
    outputJson: 'bench.json',
  }, [], 'benchmark')
  expect(result.exitCode).toBe(0)

  const benchResult = await fs.promises.readFile(benchFile, 'utf-8')
  const resultJson: FormattedBenchmarkReport = JSON.parse(benchResult)
  const names = resultJson.files.map(f => f.groups.map(g => [g.fullName, g.benchmarks.map(b => b.name)]))
  expect(names).toMatchInlineSnapshot(`
    [
      [
        [
          "base.bench.ts > sort",
          [
            "normal",
            "reverse",
          ],
        ],
        [
          "base.bench.ts > timeout",
          [
            "timeout100",
            "timeout75",
            "timeout50",
            "timeout25",
          ],
        ],
      ],
      [],
      [
        [
          "only.bench.ts",
          [
            "visited",
            "visited2",
          ],
        ],
        [
          "only.bench.ts > a0",
          [
            "0",
          ],
        ],
        [
          "only.bench.ts > a1 > b1 > c1",
          [
            "1",
          ],
        ],
        [
          "only.bench.ts > a2",
          [
            "2",
          ],
        ],
        [
          "only.bench.ts > a3 > b3",
          [
            "3",
          ],
        ],
        [
          "only.bench.ts > a4 > b4",
          [
            "4",
          ],
        ],
      ],
    ]
  `)
})
