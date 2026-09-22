export function hasTextConflict(baseText: string, draft: string, currentText: string) {
  return draft !== baseText && currentText !== baseText && draft !== currentText
}
