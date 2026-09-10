import { afterEach, expect, it, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
vi.mock('src/lang', () => ({ language: { loading: 'Loading', cancel: 'Cancel', loadingFeedback: { failed: 'Loading failed', timeout: 'Loading timed out' } } }))
import LoadingActivity from './LoadingActivity.svelte'
import { loadingActivity } from 'src/ts/gui/loadingActivity'

let component: ReturnType<typeof mount>
afterEach(async () => { if (component) await unmount(component); document.body.innerHTML = ''; loadingActivity.foreground.set(null); loadingActivity.background.set([]); loadingActivity.failure.set(null) })
it('renders accessible immediate loading without a percentage and cancels cleanly', async () => {
    component = mount(LoadingActivity, { target: document.body })
    const load = loadingActivity.select('Alpha')
    await tick()
    expect(document.querySelector('[role="dialog"]')).toBeTruthy()
    expect(document.body.textContent).toContain('Loading…')
    expect(document.querySelector('progress')).toBeNull()
    expect(document.body.textContent).not.toContain('%')
    document.querySelector('button')?.click(); await tick()
    expect(load.current()).toBe(false)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
})
it('shows pending image work and removes the status when it settles', async () => {
    component = mount(LoadingActivity, { target: document.body })
    const done = loadingActivity.begin('portrait.webp')
    await tick()
    expect(document.querySelector('[role="status"]')?.textContent).toContain('portrait.webp')
    done(); await tick()
    expect(document.querySelector('[role="status"]')).toBeNull()
})
