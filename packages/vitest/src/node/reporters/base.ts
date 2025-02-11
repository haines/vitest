import type { File, Task, TaskResultPack } from '@vitest/runner'
import type { ErrorWithDiff, UserConsoleLog } from '../../types/general'
import type { Vitest } from '../core'
import type { Reporter } from '../types/reporter'
import { performance } from 'node:perf_hooks'
import { getFullName, getSuites, getTestName, getTests, hasFailed } from '@vitest/runner/utils'
import { toArray } from '@vitest/utils'
import { parseStacktrace } from '@vitest/utils/source-map'
import { relative } from 'pathe'
import c from 'tinyrainbow'
import { isCI, isDeno, isNode } from '../../utils/env'
import { hasFailedSnapshot } from '../../utils/tasks'
import { F_CHECK, F_POINTER, F_RIGHT } from './renderers/figures'
import { countTestErrors, divider, formatProjectName, formatTimeString, getStateString, getStateSymbol, renderSnapshotSummary, taskFail, withLabel } from './renderers/utils'

const BADGE_PADDING = '       '
const LAST_RUN_LOG_TIMEOUT = 1_500

export interface BaseOptions {
  isTTY?: boolean
}

export abstract class BaseReporter implements Reporter {
  start = 0
  end = 0
  watchFilters?: string[]
  failedUnwatchedFiles: Task[] = []
  isTTY: boolean
  ctx: Vitest = undefined!

  protected verbose = false

  private _filesInWatchMode = new Map<string, number>()
  private _timeStart = formatTimeString(new Date())
  private _lastRunTimeout = 0
  private _lastRunTimer: NodeJS.Timeout | undefined
  private _lastRunCount = 0

  constructor(options: BaseOptions = {}) {
    this.isTTY = options.isTTY ?? ((isNode || isDeno) && process.stdout?.isTTY && !isCI)
  }

  onInit(ctx: Vitest) {
    this.ctx = ctx

    this.ctx.logger.printBanner()
    this.start = performance.now()
  }

  log(...messages: any) {
    this.ctx.logger.log(...messages)
  }

  error(...messages: any) {
    this.ctx.logger.error(...messages)
  }

  relative(path: string) {
    return relative(this.ctx.config.root, path)
  }

  onFinished(files = this.ctx.state.getFiles(), errors = this.ctx.state.getUnhandledErrors()) {
    this.end = performance.now()
    this.reportSummary(files, errors)
  }

  onTaskUpdate(packs: TaskResultPack[]) {
    if (this.isTTY) {
      return
    }
    for (const pack of packs) {
      const task = this.ctx.state.idMap.get(pack[0])

      if (task) {
        this.printTask(task)
      }
    }
  }

  protected printTask(task: Task) {
    if (
      !('filepath' in task)
      || !task.result?.state
      || task.result?.state === 'run') {
      return
    }

    const tests = getTests(task)
    const failed = tests.filter(t => t.result?.state === 'fail')
    const skipped = tests.filter(t => t.mode === 'skip' || t.mode === 'todo')

    let state = c.dim(`${tests.length} test${tests.length > 1 ? 's' : ''}`)

    if (failed.length) {
      state += c.dim(' | ') + c.red(`${failed.length} failed`)
    }

    if (skipped.length) {
      state += c.dim(' | ') + c.yellow(`${skipped.length} skipped`)
    }

    let suffix = c.dim('(') + state + c.dim(')') + this.getDurationPrefix(task)

    if (this.ctx.config.logHeapUsage && task.result.heap != null) {
      suffix += c.magenta(` ${Math.floor(task.result.heap / 1024 / 1024)} MB heap used`)
    }

    let title = getStateSymbol(task)

    if (task.meta.typecheck) {
      title += ` ${c.bgBlue(c.bold(' TS '))}`
    }

    if (task.projectName) {
      title += ` ${formatProjectName(task.projectName, '')}`
    }

    this.log(` ${title} ${task.name} ${suffix}`)

    for (const test of tests) {
      const duration = test.result?.duration

      if (test.result?.state === 'fail') {
        const suffix = this.getDurationPrefix(test)
        this.log(c.red(`   ${taskFail} ${getTestName(test, c.dim(' > '))}${suffix}`))

        test.result?.errors?.forEach((e) => {
          // print short errors, full errors will be at the end in summary
          this.log(c.red(`     ${F_RIGHT} ${e?.message}`))
        })
      }

      // also print slow tests
      else if (duration && duration > this.ctx.config.slowTestThreshold) {
        this.log(
          `   ${c.yellow(c.dim(F_CHECK))} ${getTestName(test, c.dim(' > '))}`
          + ` ${c.yellow(Math.round(duration) + c.dim('ms'))}`,
        )
      }
    }
  }

  private getDurationPrefix(task: Task) {
    if (!task.result?.duration) {
      return ''
    }

    const color = task.result.duration > this.ctx.config.slowTestThreshold
      ? c.yellow
      : c.gray

    return color(` ${Math.round(task.result.duration)}${c.dim('ms')}`)
  }

  onWatcherStart(files = this.ctx.state.getFiles(), errors = this.ctx.state.getUnhandledErrors()) {
    this.resetLastRunLog()

    const failed = errors.length > 0 || hasFailed(files)

    if (failed) {
      this.log(withLabel('red', 'FAIL', 'Tests failed. Watching for file changes...'))
    }
    else if (this.ctx.isCancelling) {
      this.log(withLabel('red', 'CANCELLED', 'Test run cancelled. Watching for file changes...'))
    }
    else {
      this.log(withLabel('green', 'PASS', 'Waiting for file changes...'))
    }

    const hints = [c.dim('press ') + c.bold('h') + c.dim(' to show help')]

    if (hasFailedSnapshot(files)) {
      hints.unshift(c.dim('press ') + c.bold(c.yellow('u')) + c.dim(' to update snapshot'))
    }
    else {
      hints.push(c.dim('press ') + c.bold('q') + c.dim(' to quit'))
    }

    this.log(BADGE_PADDING + hints.join(c.dim(', ')))

    if (this._lastRunCount) {
      const LAST_RUN_TEXT = `rerun x${this._lastRunCount}`
      const LAST_RUN_TEXTS = [
        c.blue(LAST_RUN_TEXT),
        c.gray(LAST_RUN_TEXT),
        c.dim(c.gray(LAST_RUN_TEXT)),
      ]
      this.ctx.logger.logUpdate(BADGE_PADDING + LAST_RUN_TEXTS[0])
      this._lastRunTimeout = 0
      this._lastRunTimer = setInterval(() => {
        this._lastRunTimeout += 1
        if (this._lastRunTimeout >= LAST_RUN_TEXTS.length) {
          this.resetLastRunLog()
        }
        else {
          this.ctx.logger.logUpdate(
            BADGE_PADDING + LAST_RUN_TEXTS[this._lastRunTimeout],
          )
        }
      }, LAST_RUN_LOG_TIMEOUT / LAST_RUN_TEXTS.length)
    }
  }

  private resetLastRunLog() {
    clearInterval(this._lastRunTimer)
    this._lastRunTimer = undefined
    this.ctx.logger.logUpdate.clear()
  }

  onWatcherRerun(files: string[], trigger?: string) {
    this.resetLastRunLog()
    this.watchFilters = files
    this.failedUnwatchedFiles = this.ctx.state.getFiles().filter(file =>
      !files.includes(file.filepath) && hasFailed(file),
    )

    // Update re-run count for each file
    files.forEach((filepath) => {
      let reruns = this._filesInWatchMode.get(filepath) ?? 0
      this._filesInWatchMode.set(filepath, ++reruns)
    })

    let banner = trigger ? c.dim(`${this.relative(trigger)} `) : ''

    if (files.length > 1 || !files.length) {
      // we need to figure out how to handle rerun all from stdin
      this._lastRunCount = 0
    }
    else if (files.length === 1) {
      const rerun = this._filesInWatchMode.get(files[0]) ?? 1
      banner += c.blue(`x${rerun} `)
    }

    this.ctx.logger.clearFullScreen()
    this.log(withLabel('blue', 'RERUN', banner))

    if (this.ctx.configOverride.project) {
      this.log(BADGE_PADDING + c.dim(' Project name: ') + c.blue(toArray(this.ctx.configOverride.project).join(', ')))
    }

    if (this.ctx.filenamePattern) {
      this.log(BADGE_PADDING + c.dim(' Filename pattern: ') + c.blue(this.ctx.filenamePattern))
    }

    if (this.ctx.configOverride.testNamePattern) {
      this.log(BADGE_PADDING + c.dim(' Test name pattern: ') + c.blue(String(this.ctx.configOverride.testNamePattern)))
    }

    this.log('')

    if (!this.isTTY) {
      for (const task of this.failedUnwatchedFiles) {
        this.printTask(task)
      }
    }

    this._timeStart = formatTimeString(new Date())
    this.start = performance.now()
  }

  onUserConsoleLog(log: UserConsoleLog) {
    if (!this.shouldLog(log)) {
      return
    }

    const output
      = log.type === 'stdout'
        ? this.ctx.logger.outputStream
        : this.ctx.logger.errorStream

    const write = (msg: string) => (output as any).write(msg)

    let headerText = 'unknown test'
    const task = log.taskId ? this.ctx.state.idMap.get(log.taskId) : undefined

    if (task) {
      headerText = getFullName(task, c.dim(' > '))
    }
    else if (log.taskId && log.taskId !== '__vitest__unknown_test__') {
      headerText = log.taskId
    }

    write(c.gray(log.type + c.dim(` | ${headerText}\n`)) + log.content)

    if (log.origin) {
      // browser logs don't have an extra end of line at the end like Node.js does
      if (log.browser) {
        write('\n')
      }

      const project = log.taskId
        ? this.ctx.getProjectByTaskId(log.taskId)
        : this.ctx.getRootTestProject()

      const stack = log.browser
        ? (project.browser?.parseStacktrace(log.origin) || [])
        : parseStacktrace(log.origin)

      const highlight = task && stack.find(i => i.file === task.file.filepath)

      for (const frame of stack) {
        const color = frame === highlight ? c.cyan : c.gray
        const path = relative(project.config.root, frame.file)

        const positions = [
          frame.method,
          `${path}:${c.dim(`${frame.line}:${frame.column}`)}`,
        ]
          .filter(Boolean)
          .join(' ')

        write(color(` ${c.dim(F_POINTER)} ${positions}\n`))
      }
    }

    write('\n')
  }

  onTestRemoved(trigger?: string) {
    this.log(c.yellow('Test removed...') + (trigger ? c.dim(` [ ${this.relative(trigger)} ]\n`) : ''))
  }

  shouldLog(log: UserConsoleLog) {
    if (this.ctx.config.silent) {
      return false
    }
    const shouldLog = this.ctx.config.onConsoleLog?.(log.content, log.type)
    if (shouldLog === false) {
      return shouldLog
    }
    return true
  }

  onServerRestart(reason?: string) {
    this.log(c.bold(c.magenta(
      reason === 'config'
        ? '\nRestarting due to config changes...'
        : '\nRestarting Vitest...',
    )))
  }

  reportSummary(files: File[], errors: unknown[]) {
    this.printErrorsSummary(files, errors)

    if (this.ctx.config.mode === 'benchmark') {
      this.reportBenchmarkSummary(files)
    }
    else {
      this.reportTestSummary(files, errors)
    }
  }

  reportTestSummary(files: File[], errors: unknown[]) {
    const affectedFiles = [
      ...this.failedUnwatchedFiles,
      ...files,
    ]
    const tests = getTests(affectedFiles)

    const snapshotOutput = renderSnapshotSummary(
      this.ctx.config.root,
      this.ctx.snapshot.summary,
    )

    for (const [index, snapshot] of snapshotOutput.entries()) {
      const title = index === 0 ? 'Snapshots' : ''
      this.log(`${padTitle(title)} ${snapshot}`)
    }

    if (snapshotOutput.length > 1) {
      this.log()
    }

    this.log(padTitle('Test Files'), getStateString(affectedFiles))
    this.log(padTitle('Tests'), getStateString(tests))

    if (this.ctx.projects.some(c => c.config.typecheck.enabled)) {
      const failed = tests.filter(t => t.meta?.typecheck && t.result?.errors?.length)

      this.log(
        padTitle('Type Errors'),
        failed.length
          ? c.bold(c.red(`${failed.length} failed`))
          : c.dim('no errors'),
      )
    }

    if (errors.length) {
      this.log(
        padTitle('Errors'),
        c.bold(c.red(`${errors.length} error${errors.length > 1 ? 's' : ''}`)),
      )
    }

    this.log(padTitle('Start at'), this._timeStart)

    const collectTime = sum(files, file => file.collectDuration)
    const testsTime = sum(files, file => file.result?.duration)
    const setupTime = sum(files, file => file.setupDuration)

    if (this.watchFilters) {
      this.log(padTitle('Duration'), time(collectTime + testsTime + setupTime))
    }
    else {
      const executionTime = this.end - this.start
      const environmentTime = sum(files, file => file.environmentLoad)
      const prepareTime = sum(files, file => file.prepareDuration)
      const transformTime = sum(this.ctx.projects, project => project.vitenode.getTotalDuration())
      const typecheck = sum(this.ctx.projects, project => project.typechecker?.getResult().time)

      const timers = [
        `transform ${time(transformTime)}`,
        `setup ${time(setupTime)}`,
        `collect ${time(collectTime)}`,
        `tests ${time(testsTime)}`,
        `environment ${time(environmentTime)}`,
        `prepare ${time(prepareTime)}`,
        typecheck && `typecheck ${time(typecheck)}`,
      ].filter(Boolean).join(', ')

      this.log(padTitle('Duration'), time(executionTime) + c.dim(` (${timers})`))
    }

    this.log()
  }

  private printErrorsSummary(files: File[], errors: unknown[]) {
    const suites = getSuites(files)
    const tests = getTests(files)

    const failedSuites = suites.filter(i => i.result?.errors)
    const failedTests = tests.filter(i => i.result?.state === 'fail')
    const failedTotal = countTestErrors(failedSuites) + countTestErrors(failedTests)

    let current = 1
    const errorDivider = () => this.error(`${c.red(c.dim(divider(`[${current++}/${failedTotal}]`, undefined, 1)))}\n`)

    if (failedSuites.length) {
      this.error(`${errorBanner(`Failed Suites ${failedSuites.length}`)}\n`)
      this.printTaskErrors(failedSuites, errorDivider)
    }

    if (failedTests.length) {
      this.error(`${errorBanner(`Failed Tests ${failedTests.length}`)}\n`)
      this.printTaskErrors(failedTests, errorDivider)
    }

    if (errors.length) {
      this.ctx.logger.printUnhandledErrors(errors)
      this.error()
    }
  }

  reportBenchmarkSummary(files: File[]) {
    const benches = getTests(files)
    const topBenches = benches.filter(i => i.result?.benchmark?.rank === 1)

    this.log(withLabel('cyan', 'BENCH', 'Summary\n'))

    for (const bench of topBenches) {
      const group = bench.suite || bench.file

      if (!group) {
        continue
      }

      const groupName = getFullName(group, c.dim(' > '))
      this.log(`  ${bench.name}${c.dim(` - ${groupName}`)}`)

      const siblings = group.tasks
        .filter(i => i.meta.benchmark && i.result?.benchmark && i !== bench)
        .sort((a, b) => a.result!.benchmark!.rank - b.result!.benchmark!.rank)

      for (const sibling of siblings) {
        const number = (sibling.result!.benchmark!.mean / bench.result!.benchmark!.mean).toFixed(2)
        this.log(c.green(`    ${number}x `) + c.gray('faster than ') + sibling.name)
      }

      this.log('')
    }
  }

  private printTaskErrors(tasks: Task[], errorDivider: () => void) {
    const errorsQueue: [error: ErrorWithDiff | undefined, tests: Task[]][] = []

    for (const task of tasks) {
      // Merge identical errors
      task.result?.errors?.forEach((error) => {
        let previous

        if (error?.stackStr) {
          previous = errorsQueue.find((i) => {
            if (i[0]?.stackStr !== error.stackStr) {
              return false
            }

            const currentProjectName = (task as File)?.projectName || task.file?.projectName || ''
            const projectName = (i[1][0] as File)?.projectName || i[1][0].file?.projectName || ''

            return projectName === currentProjectName
          })
        }

        if (previous) {
          previous[1].push(task)
        }
        else {
          errorsQueue.push([error, [task]])
        }
      })
    }

    for (const [error, tasks] of errorsQueue) {
      for (const task of tasks) {
        const filepath = (task as File)?.filepath || ''
        const projectName = (task as File)?.projectName || task.file?.projectName || ''

        let name = getFullName(task, c.dim(' > '))

        if (filepath) {
          name += c.dim(` [ ${this.relative(filepath)} ]`)
        }

        this.ctx.logger.error(
          `${c.red(c.bold(c.inverse(' FAIL ')))}${formatProjectName(projectName)} ${name}`,
        )
      }

      const screenshotPaths = tasks.map(t => t.meta?.failScreenshotPath).filter(screenshot => screenshot != null)

      this.ctx.logger.printError(error, {
        project: this.ctx.getProjectByTaskId(tasks[0].id),
        verbose: this.verbose,
        screenshotPaths,
        task: tasks[0],
      })

      errorDivider()
    }
  }
}

function errorBanner(message: string) {
  return c.red(divider(c.bold(c.inverse(` ${message} `))))
}

function padTitle(str: string) {
  return c.dim(`${str.padStart(11)} `)
}

function time(time: number) {
  if (time > 1000) {
    return `${(time / 1000).toFixed(2)}s`
  }
  return `${Math.round(time)}ms`
}

function sum<T>(items: T[], cb: (_next: T) => number | undefined) {
  return items.reduce((total, next) => {
    return total + Math.max(cb(next) || 0, 0)
  }, 0)
}
