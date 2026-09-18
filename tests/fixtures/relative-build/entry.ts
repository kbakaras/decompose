document.querySelector<HTMLBaseElement>('base')!.href = document.baseURI
document.getElementById('load')!.onclick = async () => {
  const { text } = await import('./lazy')
  const result = document.getElementById('result')!
  result.className = 'lazy-result'
  result.textContent = text
}
export {}
