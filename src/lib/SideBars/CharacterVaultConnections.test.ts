import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('Character Vault sidebar integration', () => {
    test('places Character Vault below persona and above the quick inventory', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        expect(sidebar.indexOf('data-sidebar-persona'))
            .toBeLessThan(sidebar.indexOf('data-character-vault-button'))
        expect(sidebar.indexOf('data-character-vault-button'))
            .toBeLessThan(sidebar.indexOf('data-quick-inventory'))
    })

    test('matches the persona and Vault sizes with contrasting 4px outlines', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        const personaStart = sidebar.indexOf('data-sidebar-persona')
        const vaultStart = sidebar.indexOf('data-character-vault-button')
        const inventoryStart = sidebar.indexOf('data-quick-inventory')
        const persona = sidebar.slice(personaStart, vaultStart)
        const vault = sidebar.slice(vaultStart, inventoryStart)
        expect(persona).not.toContain('data-sidebar-persona-label')
        expect(sidebar).toMatch(/\.character-sidebar-primary-actions\s*\{[^}]*border-bottom:\s*1px solid var\(--color-selected\)/s)
        expect(persona).toContain('h-[54px] w-[54px]')
        expect(persona).toContain('outline outline-4')
        expect(persona).toContain('outline-offset-0')
        expect(persona).not.toContain('outline-offset-[-4px]')
        expect(persona).toContain('outline-borderc')
        expect(vault).toContain('character-toolbar-button--chat')
        expect(vault).not.toContain('border-b')
        expect(vault).toContain('data-character-vault-label')
        expect(vault).toContain('>저장소</span>')
        expect(vault).toContain('outline outline-4')
        expect(vault).toContain('outline-offset-0')
        expect(vault).not.toContain('outline-offset-[-4px]')
        expect(vault).toContain('outline-darkborderc')
    })

    test('uses the books artwork and swaps to its animation on hover', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        const vaultStart = sidebar.indexOf('data-character-vault-button')
        const inventoryStart = sidebar.indexOf('data-quick-inventory')
        const vault = sidebar.slice(vaultStart, inventoryStart)
        expect(sidebar).toContain("import characterVaultIdle from 'src/assets/character-vault/books1-idle.png'")
        expect(sidebar).toContain("import characterVaultHover from 'src/assets/character-vault/books1-hover.gif'")
        expect(vault).toContain('src={characterVaultIdle}')
        expect(vault).toContain('src={characterVaultHover}')
        expect(vault).toContain('group-hover:opacity-0')
        expect(vault).toContain('group-hover:opacity-100')
        expect(vault).toContain('style="width: 54px; height: 54px;"')
        expect(vault).not.toContain('<ArchiveIcon')
    })

    test('uses a 52px blue top options control with balanced vertical spacing', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        expect(sidebar).toContain('data-sidebar-options')
        expect(sidebar).toContain('data-sidebar-options-divider')
        expect(sidebar).toMatch(/data-sidebar-options[\s\S]*h-10[\s\S]*w-\[52px\][\s\S]*bg-primary[\s\S]*data-sidebar-options-divider/)
        expect(sidebar).toMatch(/data-character-sidebar-primary-actions[\s\S]*data-sidebar-options[\s\S]*data-sidebar-persona/)
        expect(sidebar).toMatch(/data-sidebar-options-divider class="w-full relative text-textcolor"/)
        expect(sidebar).not.toContain('data-sidebar-options-divider class="w-full border-b border-b-selected')
        expect(sidebar).toMatch(/data-character-sidebar\s+class="[^"]*bg-darkbg text-textcolor/)
        expect(sidebar).toMatch(/data-character-sidebar-scroll class="[^"]*pt-2 pb-6"/)
        expect(sidebar).toMatch(/data-character-workspace-header class="flex min-h-10/)
        expect(sidebar).not.toMatch(/data-character-workspace-header class="[^"]*mt-1\.5/)
    })

    test('keeps the expanded options menu above character thumbnails', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        expect(sidebar).toMatch(
            /\.character-sidebar-menu-action\s*\{[^}]*position:\s*relative[^}]*z-index:\s*30/s
        )
    })

    test('resizes the character-list rail into a centered three-column grid with a visible scrollbar', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        expect(sidebar).toContain('data-character-list-sidebar')
        expect(sidebar).toContain('bind:this={characterListSidebarElement}')
        expect(sidebar).toContain('style:width={characterListSidebarWidth}')
        expect(sidebar).toContain('field="characterListSidebarWidth"')
        expect(sidebar).toContain('data-character-sidebar-primary-actions')
        expect(sidebar).toContain('data-quick-inventory-grid')
        expect(sidebar).toMatch(/\.character-sidebar-primary-actions\s*\{[^}]*gap:\s*var\(--character-card-gap\)/s)
        expect(sidebar).toMatch(/\.character-list\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit, 56px\)[^}]*justify-content:\s*center[^}]*gap:\s*var\(--character-card-gap\)[^}]*overflow-y:\s*auto[^}]*scrollbar-gutter:\s*stable/s)
        expect(sidebar).toMatch(/\.folder-character-grid\s*\{[^}]*grid-column:\s*1 \/ -1[^}]*grid-template-columns:\s*repeat\(auto-fit, 56px\)/s)
        expect(sidebar).not.toContain('.character-list::-webkit-scrollbar {\n    display: none;')
    })

    test('renders the new-character action as a thumbnail-sized square with a tooltip', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        const start = sidebar.indexOf('data-sidebar-new-character')
        const action = sidebar.slice(start, sidebar.indexOf('</button>', start))
        expect(action).toContain('h-14 w-14')
        expect(action).toContain('rounded-md')
        expect(action).not.toContain('rounded-full')
        expect(action).toContain('aria-label="새 캐릭터"')
        expect(action).toContain('use:tooltip={"새 캐릭터"}')
    })

    test('renders entries from the stable quick-access projection', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        expect(sidebar).toContain('getCharacterVaultQuickAccess')
        expect(sidebar).toContain('<CharacterVaultDialog')
    })

    test('explains that only pinned characters appear in the sidebar', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        expect(sidebar).toContain(
            'use:tooltip={"캐릭터 저장소 · 고정한 캐릭터만 사이드바에 표시됩니다."}'
        )
    })

    test('wires desktop and touch quick-inventory drag moves through stable ids', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        expect(sidebar).toContain('moveCharacterVaultSidebarCharacter')
        expect(sidebar).toContain('reorderCharacterVaultSidebarShortcuts')
        expect(sidebar).toContain('id: cha.chaId')
        expect(sidebar).toContain('const moveSidebarItem =')
        expect(sidebar).toContain('draggable={!isTouchDevice ? "true" : undefined}')
        expect(sidebar).toContain('onTouchDragStart({ kind:')
        expect(sidebar).toContain('void requestImmediateSave()')
        expect(sidebar).not.toContain('const inserter =')
        expect(sidebar).not.toContain('const createFolder =')
    })

    test('shows a gap insertion indicator instead of outlining character cards', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        const dragOverStart = sidebar.indexOf('const avatarDragOver =')
        const dragOver = sidebar.slice(dragOverStart, sidebar.indexOf('const avatarDrop =', dragOverStart))

        expect(dragOver).toContain('quick-inventory-drop-before')
        expect(dragOver).toContain('quick-inventory-drop-after')
        expect(sidebar).toContain('resolveQuickInventoryCardDrop')
        expect(sidebar).toContain('const avatarCardDrop =')
        expect(sidebar).toContain('getComputedStyle(target.parentElement).gridTemplateColumns')
        expect(sidebar).not.toContain("classList.add('ring-2', 'ring-success')")
        expect(sidebar).toMatch(/:global\(\.quick-inventory-drop-before\)::before[\s\S]*background:\s*var\(--color-success\)/)
        expect(sidebar).toMatch(/:global\(\.quick-inventory-drop-after\)::after[\s\S]*background:\s*var\(--color-success\)/)
        expect(sidebar).toContain('const clearAvatarDragFeedback =')
        expect(sidebar).toContain('ondragleave={!isTouchDevice ? clearAvatarDragFeedback : undefined}')
    })

    test('pins successful CharX imports at the bottom of quick access', () => {
        const cards = source('src/ts/characterCards.ts')
        const charxStart = cards.indexOf("if(f.name.endsWith('charx')")
        const pngStart = cards.indexOf("if(!f.name.endsWith('png')", charxStart)
        const charxImport = cards.slice(charxStart, pngStart)
        expect(cards).toContain("import { pinCharacterVaultQuickAccess } from './characterVault'")
        expect(charxImport).toContain('pinCharacterVaultQuickAccess(db, importedCharacter.chaId)')
    })

    test('pins characters created from scratch at the bottom of quick access', () => {
        const characters = source('src/ts/characters.ts')
        const createStart = characters.indexOf('export function createNewCharacter()')
        const createEnd = characters.indexOf('\n}', createStart)
        const createCharacter = characters.slice(createStart, createEnd)

        expect(characters).toContain(
            "import { clearCharacterVaultNew, pinCharacterVaultQuickAccess } from './characterVault'"
        )
        expect(createCharacter).toContain('pinCharacterVaultQuickAccess(db, character.chaId)')
    })

    test('shows a bordered star-shine badge for new characters', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        const icons = source('src/lib/UI/Icons/SolarBoldIcon.svelte')
        expect(sidebar).toContain('isCharacterVaultNew')
        expect(sidebar).toContain('data-new-character-badge')
        expect(sidebar).toContain('<SolarBoldIcon name="star-shine"')
        expect(sidebar).toContain('aria-label="새 캐릭터"')
        expect(sidebar).toContain('stroke: var(--color-shadow);')
        expect(sidebar).toContain('stroke-width: 2px;')
        expect(sidebar).toContain('fill: var(--color-media-text);')
        expect(icons).toContain("| 'star-shine'")
    })

    test('clears the new-character badge through the shared access path', () => {
        const characters = source('src/ts/characters.ts')
        const changeStart = characters.indexOf('export async function changeChar(')
        const changeCharacter = characters.slice(changeStart)
        expect(characters).toContain(
            "import { clearCharacterVaultNew, pinCharacterVaultQuickAccess } from './characterVault'"
        )
        expect(characters).toContain('changeChar(db.characters.length-1, { clearNewBadge: false })')
        expect(changeCharacter).toContain('if(arg.clearNewBadge !== false)')
        expect(changeCharacter).toContain('clearCharacterVaultNew(db, char.chaId)')
    })

    test('exposes one shared modal state from the app stores', () => {
        expect(source('src/ts/stores.svelte.ts'))
            .toContain('export const characterVaultOpen = writable(false)')
    })

    test('renders custom folder colors in the quick inventory', () => {
        expect(source('src/lib/SideBars/SidebarAvatar.svelte'))
            .toContain("color.startsWith('#') ? color : undefined")
    })

    test('keeps pinned bot images stable across sidebar hover updates', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')

        expect(sidebar).toContain('const sidebarImageCache = new Map')
        expect(sidebar).toContain('function sidebarCharacterImage(')
        expect(sidebar).toContain('src={char.img ? sidebarCharacterImage(char.img) : "/none.webp"}')
        expect(sidebar).toContain('src={char2.img ? sidebarCharacterImage(char2.img) : "/none.webp"}')
    })

    test('selects pinned bots on mouse press before native drag can suppress click', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        const quickInventory = sidebar.slice(
            sidebar.indexOf('data-quick-inventory'),
            sidebar.indexOf('data-sidebar-new-character'),
        )

        expect(quickInventory).toContain('onpointerdown={(event) => selectPinnedCharacterOnMouse(')
        expect(quickInventory).toContain('if(isTouchDevice && char.type === "normal")')
        expect(quickInventory).toContain('if(isTouchDevice && char2.type === "normal")')
    })

    test('resolves quick folder context actions by stable folder id', () => {
        const sidebar = source('src/lib/SideBars/Sidebar.svelte')
        expect(sidebar).toContain('const folderIndex = getFolderIndex(char.id)')
    })

    test('supports Escape dismissal and a true mobile fullscreen Vault', () => {
        const dialog = source('src/lib/SideBars/CharacterVaultDialog.svelte')
        expect(dialog).toContain('closeOnEscape')
        expect(dialog).toContain('max-width: 100vw !important')
    })

    test('turns the mobile folder rail into a scrollable off-canvas sidebar', () => {
        const dialog = source('src/lib/SideBars/CharacterVaultDialog.svelte')
        expect(dialog).toMatch(
            /\.folder-list\s*\{[^}]*flex:\s*1 1 auto;[^}]*overflow-y:\s*auto;[^}]*scrollbar-gutter:\s*stable;/s
        )
        expect(dialog).toContain('class:open={folderSidebarOpen}')
        expect(dialog).toContain('aria-controls="character-vault-folders"')
        expect(dialog).toMatch(/\.vault-rail\.open\s*\{[^}]*transform:\s*translateX\(0\)/s)
        expect(dialog).toContain('.folder-sidebar-scrim')
        expect(dialog).not.toContain('grid-template-rows: clamp(10rem, 34dvh, 22rem)')
        expect(dialog).not.toContain('.folder-list { display: flex;')
    })

    test('uses the defined theme tokens for opaque Vault surfaces', () => {
        const dialog = source('src/lib/SideBars/CharacterVaultDialog.svelte')
        expect(dialog).toContain('var(--color-darkbg)')
        expect(dialog).not.toMatch(
            /var\(--(?:darkbg|darkborderc|borderc|selected|textcolor|textcolor2)\)/
        )
    })

    test('uses the requested Solar Bold icons for Vault actions', () => {
        const dialog = source('src/lib/SideBars/CharacterVaultDialog.svelte')
        const icons = source('src/lib/UI/Icons/SolarBoldIcon.svelte')
        for (const name of [
            'add-folder',
            'remove-folder',
            'trash-bin-trash',
            'play-circle',
        ]) {
            expect(icons).toContain(`| '${name}'`)
            expect(dialog).toContain(`name="${name}"`)
        }
    })

    test('renders square character cards with a hover title and the open action in the portrait', () => {
        const dialog = source('src/lib/SideBars/CharacterVaultDialog.svelte')
        expect(dialog).toContain('aspect-ratio: 1')
        expect(dialog).toContain('.character-card:hover .character-caption')
        expect(dialog).toContain('class="open-character"')
        expect(dialog.indexOf('class="open-character"'))
            .toBeLessThan(dialog.indexOf('class="character-caption"'))
    })
})
