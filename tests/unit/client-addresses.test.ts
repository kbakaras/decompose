import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { collaborationUrl } from '../../src/client/collaboration-url'

it.each([
  ['http://localhost:3000/', 'ws://localhost:3000/collaboration'],
  ['http://decompose.luxburg/', 'ws://decompose.luxburg/collaboration'],
  ['http://decompose.test:8080/decompose/', 'ws://decompose.test:8080/decompose/collaboration'],
  ['https://another-host.example/', 'wss://another-host.example/collaboration'],
  ['https://another-host.example:8443/?diagram=main', 'wss://another-host.example:8443/collaboration'],
  ['http://[::1]:8080/', 'ws://[::1]:8080/collaboration'],
  ['https://another-host.example:8443/tools/tree/', 'wss://another-host.example:8443/tools/tree/collaboration'],
])('builds collaboration URL from %s', (page, expected) => {
  expect(collaborationUrl(new URL(page))).toBe(expected)
})

it('keeps browser source free of fixed network endpoints and direct UUID calls outside the helper', () => {
  const namespaces = new Set(['http://graphml.graphdrawing.org/xmlns', 'http://www.yworks.com/xml/graphml'])
  for (const directory of ['src/client', 'src/domain', 'src/shared']) {
    for (const file of readdirSync(directory, { recursive: true, encoding: 'utf8' }).filter(file => /\.tsx?$/.test(file))) {
      const source = readFileSync(resolve(directory, file), 'utf8')
      // Упоминание ограничения браузера в тексте титульной страницы — не сетевой адрес.
      expect(source.replace('HTTPS либо localhost.', ''), `${directory}/${file}`).not.toMatch(/\blocalhost\b|127\.0\.0\.1/)
      const urls = source.match(/\b(?:https?|wss?):\/\/[^\s'"`]+/g) ?? []
      expect(urls.filter(url => !(file === 'yed-import.ts' && namespaces.has(url))), `${directory}/${file}`).toEqual([])
      if (directory !== 'src/shared' || file !== 'uuid.ts') {
        expect(source, `${directory}/${file}`).not.toMatch(/\.randomUUID\s*\(/)
      }
      expect(source, `${directory}/${file}`).not.toMatch(/fetch\(\s*['"`]\/|(?:href|src)=["']\//)
    }
  }
})
