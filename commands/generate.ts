import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { Project, QuoteKind } from 'ts-morph'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { RouteJSON } from '@adonisjs/core/types/http'
import { parseBindingReference, slash } from '@adonisjs/core/helpers'
import stringHelpers from '@adonisjs/core/helpers/string'
import { dirname, relative } from 'node:path'
import { x } from 'tinyexec'
import { RuntimeException } from '@adonisjs/core/exceptions'
import { FinesConfig } from '../src/types.js'

type Space = ('start' | 'end')[]

type ParsedRoute = {
  path: string
  method: string
  form: boolean
  name: {
    key: string
    type: string
  }
  controller: {
    relative: string
    path: string
  }
}

export default class SkemaGenerate extends BaseCommand {
  static commandName = 'skema:generate'
  static description = 'Generate API schema from routes'

  @flags.boolean({
    default: true,
  })
  declare formatting: boolean

  @flags.boolean({
    default: true,
  })
  declare typechecking: boolean

  @flags.boolean({
    default: true,
  })
  declare linting: boolean

  static options: CommandOptions = {
    startApp: true,
  }

  #config = () => {
    const rawConfig = this.app.config.get<FinesConfig | null>('fines', null)

    if (!rawConfig) {
      throw new RuntimeException(
        'Invalid "config/fines.ts" file. Make sure you are using the "defineConfig" method'
      )
    }

    return rawConfig
  }

  #getRootPath = (path: string) => fileURLToPath(new URL(path, this.app.appRoot))

  #getClientPath = (path?: string) => this.#getRootPath(`./client/${path || ''}`)

  #getSchemaPath = (group?: string) => this.#getClientPath(`${group || ''}/schema.ts`)

  #getReferencePath = () => this.#getClientPath('reference.ts')

  #getRelativePath = (from: string, to: string) => slash(relative(from, to))

  #prepareDestination() {
    const directory = this.#getClientPath()

    if (existsSync(directory)) {
      const files = readdirSync(directory)

      for (const file of files) {
        if (!file.endsWith('.ts')) {
          rmSync(file, { recursive: true, force: true })
        }
      }
    } else {
      mkdirSync(directory, { recursive: true })
    }
  }

  #getMethod(methods: string[]) {
    let result = 'GET'

    for (const method of methods) {
      const lowerMethod = method.toLowerCase()

      if (lowerMethod === 'head') {
        continue
      }

      result = lowerMethod.toUpperCase()
    }

    return result
  }

  #getConstructorAction(path: string) {
    const fileName = path.split('/').pop()

    if (!fileName) {
      throw new Error('Unable to determine the file name', {
        cause: {
          path,
        },
      })
    }

    if (!fileName.endsWith('_controller.ts')) {
      throw new Error('The file name must end with "_controller.ts"', {
        cause: {
          path,
        },
      })
    }

    return fileName.replace('_controller.ts', '').split('_')
  }

  async #groupRoutes(routes: RouteJSON[]) {
    const config = this.#config()

    const result = new Map<string, RouteJSON[]>()

    for (const route of routes) {
      let group: string | undefined

      for (const [key, value] of Object.entries(config.groups)) {
        if (route.pattern.startsWith(value)) {
          group = key
          break
        }
      }

      if (!group) {
        group = 'internal'
      }

      if (!result.has(group)) {
        result.set(group, [])
      }

      result.get(group)!.push(route)
    }

    return result
  }

  async #getRoutes() {
    const router = await this.app.container.make('router')

    router.commit()

    return router.toJSON().root
  }

  async #command(params: {
    name: string
    command: {
      main: string
      args?: string[]
    }
    spacing?: Space | true
    active?: boolean
  }) {
    if (params.active === false) {
      return
    }

    if (params.spacing === true || params.spacing?.includes('start')) {
      console.log('')
    }

    const action = this.logger.action(params.name)

    const res = await x(params.command.main, params.command.args)

    if (res.exitCode !== 0) {
      for (const line of res.stdout.slice(0, -1).split('\n')) {
        this.logger.info(line)
      }

      console.log('')

      for (const line of res.stderr.slice(0, -1).split('\n')) {
        this.logger.error(line)
      }

      console.log('')

      action.displayDuration().failed('')

      process.exit(1)
    }

    action.displayDuration().succeeded()

    if (params.spacing === true || params.spacing?.includes('end')) {
      console.log('')
    }
  }

  #action(name: string) {
    const action = this.logger.action(name)

    return {
      succeeded: (internalSpacing?: Space | true) => {
        if (internalSpacing === true || internalSpacing?.includes('start')) {
          console.log('')
        }

        action.displayDuration().succeeded()

        if (internalSpacing === true || internalSpacing?.includes('end')) {
          console.log('')
        }
      },

      skipped: (message?: string, internalSpacing?: Space | true) => {
        if (internalSpacing === true || internalSpacing?.includes('start')) {
          console.log('')
        }

        action.displayDuration().skipped(message)

        if (internalSpacing === true || internalSpacing?.includes('end')) {
          console.log('')
        }
      },
    }
  }

  async #writeSchemaFile(group: string, routes: ParsedRoute[]) {
    const file = this.#project.createSourceFile(this.#getSchemaPath(group), '', { overwrite: true })

    if (!file) throw new Error('Unable to create the schema.ts file')

    const referenceFilePath = this.#getRelativePath(
      this.#getClientPath(group),
      this.#getClientPath('reference.ts')
    )

    file.removeText().insertText(0, (writer) => {
      writer.writeLine(`/// <reference path="${referenceFilePath}" />`)

      writer.newLine()

      writer.writeLine(`import { InferController, register } from '@xtriangle/skema'`)

      writer.newLine()

      writer.writeLine(`/*`)
      writer.writeLine(` * This is an auto-generated file. Changes made to this file will be lost.`)
      writer.writeLine(' * Run `nr ace skema:generate` to update it.')
      writer.writeLine(` */`)

      writer.newLine()

      routes.forEach((route) => {
        writer.writeLine(
          `export type ${route.name.type} = InferController<(typeof import('${route.controller.relative}'))['default']>`
        )
      })

      writer.newLine()

      writer
        .write('export const routes = ')
        .inlineBlock(() => {
          routes.forEach((route) => {
            writer.writeLine(
              `${route.name.key}: register<${route.name.type}>({ form: ${route.form}, path: '${route.path}', method: '${route.method}' }),`
            )
          })
        })
        .write(' as const')
    })

    await file.save()
  }

  async #writeReferenceFile() {
    const path = this.#getReferencePath()

    if (existsSync(path)) {
      return
    }

    const file = this.#project.createSourceFile(path, '', { overwrite: true })

    const rcFilePath = this.#getRelativePath(dirname(path), this.#getRootPath('adonisrc.ts'))

    file.removeText().insertText(0, (writer) => {
      writer.writeLine(`/// <reference path="${rcFilePath}" />`)

      writer.newLine()

      writer.writeLine(`/* Add the required types here */`)
    })

    await file.save()
  }

  #project = new Project({
    manipulationSettings: { quoteKind: QuoteKind.Single, useTrailingCommas: true },
    tsConfigFilePath: this.#getRootPath('tsconfig.json'),
  })

  async run() {
    const generatingClient = this.#action('Generating client')

    const prepareDestination = this.#action('Preparing destination')

    this.#prepareDestination()

    prepareDestination.succeeded(['end'])

    const getRoutes = this.#action('Getting routes')

    const routes = await this.#groupRoutes(await this.#getRoutes())

    getRoutes.succeeded(['end'])

    await this.#command({
      name: 'Formatting files',
      command: {
        main: 'prettier',
        args: ['--write', '.'],
      },
      spacing: ['end'],
      active: this.formatting,
    })

    await this.#command({
      name: 'Typechecking',
      command: {
        main: 'tsc',
        args: ['--noEmit'],
      },
      spacing: ['end'],
      active: this.typechecking,
    })

    await this.#command({
      name: 'Linting',
      command: {
        main: 'eslint',
        args: ['.'],
      },
      spacing: ['end'],
      active: this.linting,
    })

    const writingReferenceFile = this.#action('Writing reference file')

    await this.#writeReferenceFile()

    writingReferenceFile.succeeded()

    const parsingRoutes = this.#action('Parsing routes')

    const sourcesFiles = this.#project.getSourceFiles()

    const allParsedRoutes: ParsedRoute[] = []

    for (const [group, groupRoutes] of routes.entries()) {
      const parsedRoutes: ParsedRoute[] = []

      const parsingGroup = this.#action(`Parsing group "${group}"`)

      for (const route of groupRoutes) {
        const parsingRoute = this.#action(`Parsing route "${route.pattern}" in group "${group}"`)

        if (typeof route.handler === 'function') {
          parsingRoute.skipped(`We don't support function routes`, ['start'])
          continue
        }

        const routeHandler = await parseBindingReference(route.handler.reference)

        const routeSourceFile = sourcesFiles.find((sf) =>
          sf.getFilePath().endsWith(`${routeHandler.moduleNameOrPath.replace('#', '')}.ts`)
        )

        if (!routeSourceFile) {
          parsingRoute.skipped(`We couldn't find the source file`, ['start'])
          continue
        }

        const relativePath = this.#getRelativePath(
          this.#getClientPath(group),
          routeSourceFile.getFilePath()
        )

        const spacedPath: string[] = []

        for (const segment of route.pattern.split(/[./-]+/)) {
          if (!segment.startsWith(':')) {
            spacedPath.push(segment)
          }
        }

        spacedPath.push(...this.#getConstructorAction(relativePath))

        const joinedSpacedPath = [
          ...new Set(spacedPath.map((s) => stringHelpers.snakeCase(s))),
        ].join(' ')

        const keyName = stringHelpers.snakeCase(joinedSpacedPath).toUpperCase()
        const typeName = `${stringHelpers.pascalCase(joinedSpacedPath)}Route`

        const splittedPath = route.pattern.split('/').slice(1)

        for (const [segmentIndex, segment] of splittedPath.entries()) {
          if (segment.startsWith(':')) {
            if (segment.match(/^:[a-zA-Z]+$/i)) {
              splittedPath[segmentIndex] = `{{ ${segment.replace(':', '')} }}`
            } else {
              throw new Error('Only small letters allowed in parameter segments', {
                cause: {
                  segment: segmentIndex,
                  route: route.pattern,
                },
              })
            }
          } else {
            if (!segment.match(/^[a-z0-9-]+$/i)) {
              throw new Error('Only small letters and number allowed in non parameter segments', {
                cause: {
                  segment: segmentIndex,
                  route: route.pattern,
                },
              })
            }
          }
        }

        const parsedRouteDraft: ParsedRoute = {
          path: `/${splittedPath.join('/')}`,
          method: this.#getMethod(route.methods),
          form: false,
          controller: {
            relative: relativePath,
            path: routeHandler.moduleNameOrPath,
          },
          name: {
            key: keyName,
            type: typeName,
          },
        }

        parsingRoute.succeeded(['start'])

        const validatingRoute = this.#action(
          `Validating route "${route.pattern}" - "${parsedRouteDraft.method}"`
        )

        for (const parsedRoute of allParsedRoutes) {
          if (parsedRoute.controller.path === parsedRouteDraft.controller.path) {
            throw new Error(
              `The controller ${parsedRouteDraft.controller.path} is already registered`,
              {
                cause: {
                  currentRoute: parsedRouteDraft,
                  registeredRoute: parsedRoute,
                },
              }
            )
          }

          if (parsedRoute.name.key === parsedRouteDraft.name.key) {
            throw new Error(`The controller key has already been registered`, {
              cause: {
                currentRoute: parsedRouteDraft,
                registeredRoute: parsedRoute,
              },
            })
          }
        }

        const classDef = routeSourceFile.getClasses().find((c) => c.isDefaultExport())

        if (!classDef) {
          validatingRoute.skipped(`We were not able to find the default export`)
          continue
        }

        if (!classDef.getType().isClass()) {
          validatingRoute.skipped(`The default export is not a class`)
          continue
        }

        const handleMethod = classDef.getProperty('handle')
        const inputProperty = classDef.getProperty('input')
        const formProperty = classDef.getProperty('form')

        if (!handleMethod) {
          validatingRoute.skipped(`We were not able to find the "handle" method`)
          continue
        }

        if (inputProperty) {
          const inputPropertyType = inputProperty.getType()

          if (!inputPropertyType.isObject()) {
            validatingRoute.skipped(`The "input" property is not an object`)
            continue
          }
        }

        if (formProperty) {
          const formPropertyType = formProperty.getType()

          if (!formPropertyType.isBoolean()) {
            validatingRoute.skipped(`The "form" property is not a boolean`)
            continue
          }

          parsedRouteDraft.form = Boolean(formProperty.getStructure().initializer)
        }

        validatingRoute.succeeded()

        const addingRoute = this.#action(`Adding route "${route.pattern}"`)

        parsedRoutes.push(parsedRouteDraft)
        allParsedRoutes.push(parsedRouteDraft)

        addingRoute.succeeded(['end'])
      }

      parsingGroup.succeeded(['end'])

      const writingGroup = this.#action(`Writing group "${group}"`)

      await this.#writeSchemaFile(group, parsedRoutes)

      writingGroup.succeeded(['end'])
    }

    parsingRoutes.succeeded(['end'])

    await this.#command({
      name: 'Formatting client file',
      command: {
        main: 'prettier',
        args: ['--write', this.#getClientPath()],
      },
      spacing: ['end'],
      active: this.formatting,
    })

    generatingClient.succeeded(['end'])
  }
}
