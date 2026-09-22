import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lock = JSON.parse(readFileSync(resolve(root, 'package-lock.json'), 'utf8'))
const outputPath = resolve(root, 'THIRD_PARTY_NOTICES')
const check = process.argv.includes('--check')
const failures = []
const packages = []

for (const [packagePath, metadata] of Object.entries(lock.packages ?? {})) {
  if (!packagePath || metadata.dev === true) continue
  const match = packagePath.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/)
  if (!match) continue

  const directory = resolve(root, packagePath)
  const manifestPath = resolve(directory, 'package.json')
  if (!existsSync(manifestPath)) {
    failures.push(`${packagePath}: пакет не установлен; сначала выполни npm ci`)
    continue
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const name = manifest.name ?? match[1]
  const version = manifest.version ?? metadata.version
  const license = metadata.license ?? manifest.license
  const licenseFiles = readdirSync(directory)
    .filter(file => /^(licen[cs]e|copying|notice)(\.|$)/i.test(file))
    .sort()
    .map(file => {
      const path = resolve(directory, file)
      return {
        path: relative(root, path).replaceAll('\\', '/'),
        text: readFileSync(path, 'utf8').replaceAll('\r\n', '\n').trimEnd(),
      }
    })

  if (typeof license !== 'string' || !license.trim()) failures.push(`${name}@${version}: в package metadata не указана лицензия`)
  if (!licenseFiles.length) failures.push(`${name}@${version}: в пакете отсутствует файл лицензии`)
  packages.push({ name, version, license, licenseFiles })
}

if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}

packages.sort((left, right) => left.name.localeCompare(right.name, 'en') || left.version.localeCompare(right.version, 'en'))
const texts = new Map()
for (const item of packages) {
  for (const file of item.licenseFiles) {
    const group = texts.get(file.text) ?? { packages: new Set(), paths: new Set() }
    group.packages.add(`${item.name}@${item.version}`)
    group.paths.add(file.path)
    texts.set(file.text, group)
  }
}
const licenseTexts = [...texts.entries()].sort((left, right) =>
  [...left[1].packages].sort()[0].localeCompare([...right[1].packages].sort()[0], 'en'))
const lines = [
  'THIRD-PARTY SOFTWARE NOTICES',
  '',
  'Decompose incorporates the production dependencies listed below.',
  'The full license and notice texts follow the inventory and are also retained in the package directories under node_modules.',
  'The generated browser distribution includes this complete file in licenses/THIRD_PARTY_NOTICES.',
  '',
  ...packages.map(item => `${item.name}@${item.version} | ${item.license}`),
  '',
  'ELK.js is distributed under the Eclipse Public License 2.0.',
  'Its source and license information are available at https://github.com/kieler/elkjs.',
  '',
  'FULL LICENSE AND NOTICE TEXTS',
  '',
  ...licenseTexts.flatMap(([text, group]) => [
    '================================================================================',
    `Packages: ${[...group.packages].sort().join(', ')}`,
    `Package files: ${[...group.paths].sort().join(', ')}`,
    '--------------------------------------------------------------------------------',
    text,
    '',
  ]),
]
const expected = lines.join('\n')

if (check) {
  const actual = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : ''
  if (actual !== expected) {
    console.error('THIRD_PARTY_NOTICES не соответствует package-lock.json. Выполни npm run licenses.')
    process.exit(1)
  }
  console.log(`Проверены лицензии production-зависимостей: ${packages.length}`)
} else {
  writeFileSync(outputPath, expected)
  console.log(`THIRD_PARTY_NOTICES обновлён, production-зависимостей: ${packages.length}`)
}
