/** Расстояние от каталога SPA-страницы до корня приложения после снятия proxy-префикса. */
export function relativeAppRoot(pathname: string): string {
  return '../'.repeat(Math.max(0, pathname.split('/').length - 2)) || './'
}

/** В HTML попадает только относительное расстояние, не Host или пользовательский URL. */
export function setHtmlBase(html: string, relativeBase: string): string {
  if (!/^(?:\.\/|(?:\.\.\/)+)$/.test(relativeBase)) throw new Error('Некорректная база HTML')
  const marker = /(<base\s+href=")[^"]*("\s+data-app-base\s*\/?>)/
  if (!marker.test(html)) throw new Error('В оболочке приложения отсутствует base')
  return html.replace(marker, (_match, before: string, after: string) => before + relativeBase + after)
}

/** Пути приложения разрешаются только относительно зафиксированной базы документа. */
export function resolveAppUrl(path: string, base: string | URL): URL {
  if (path.startsWith('/') || path.includes('\\')) throw new Error('Ожидается относительный путь приложения')
  const root = new URL(base)
  const url = new URL(path, root)
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) {
    throw new Error('Ссылка выходит за пределы приложения')
  }
  return url
}
