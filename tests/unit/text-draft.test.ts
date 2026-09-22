import { describe, expect, it } from 'vitest'
import { hasTextConflict } from '../../src/client/text-draft'

describe('черновик текста карточки', () => {
  it('не конфликтует, пока исходный текст не изменился', () => {
    expect(hasTextConflict('Исходный', 'Мой черновик', 'Исходный')).toBe(false)
  })

  it('не конфликтует, если пользователь не изменил свой черновик', () => {
    expect(hasTextConflict('Исходный', 'Исходный', 'Правка коллеги')).toBe(false)
  })

  it('не конфликтует, если черновик уже совпадает с актуальным текстом', () => {
    expect(hasTextConflict('Исходный', 'Общий результат', 'Общий результат')).toBe(false)
  })

  it('обнаруживает две разные правки одного исходного текста', () => {
    expect(hasTextConflict('Исходный', 'Мой черновик', 'Правка коллеги')).toBe(true)
  })
})
