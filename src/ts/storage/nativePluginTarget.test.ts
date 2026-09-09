import { describe, expect, it } from 'vitest'
import { withHydratedCharacter } from './nativeRuntime'

describe('stable plugin hydration targets', () => {
    it('writes the captured character after selection and array order change while loading', async () => {
        let characters = [{ chaId: 'a', desc: 'A' }, { chaId: 'b', desc: 'B' }]
        let selected = 0
        const id = characters[selected].chaId
        await withHydratedCharacter(id, () => characters, async () => {
            selected = 1
            characters.reverse()
        }, (character, index) => { characters[index] = { ...character, desc: 'edited A' } })
        expect(characters.find(char => char.chaId === 'a')?.desc).toBe('edited A')
        expect(characters.find(char => char.chaId === 'b')?.desc).toBe('B')
    })
    it('does not write a replacement character when the original is removed while loading', async () => {
        const characters = [{ chaId: 'a', desc: 'A' }, { chaId: 'b', desc: 'B' }]
        let called = false
        await withHydratedCharacter('a', () => characters, async () => { characters.shift() }, () => { called = true })
        expect(called).toBe(false)
        expect(characters[0].desc).toBe('B')
    })
})
