import { afterAll, expect, test } from 'vitest'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient } from './helpers/client.js'
import { encodeBackup } from './helpers/encode.js'
import { decodeBackup } from './helpers/decode.js'
const { decodeRisuSave, encodeRisuSaveLegacy } = require('../../server/node/utils.cjs')

const servers: ServerHandle[] = []
afterAll(async () => { await Promise.allSettled(servers.map(server => server.cleanup())) })

function backup(chat: Record<string, unknown>) {
  return encodeBackup([{ name: 'database.risudat', data: Buffer.from(encodeRisuSaveLegacy({
    characters: [{ chaId: 'pocket-char', name: 'Imported character', type: 'character', chats: [chat], chatPage: 0 }],
    botPresets: [], modules: [], personas: [], loreBook: [],
  })) }])
}

test('imports a legacy hybrid chat through streaming upload and keeps it intact after a rejected incomplete backup', async () => {
  const server = await spawnServer()
  servers.push(server)
  const client = await createClient(server.port, server.password)
  const chat = { id: 'pocket-chat', name: 'Imported chat', folderId: null, modules: [],
    message: [{ role: 'user', data: 'Question' }, { role: 'char', data: 'Answer', extension: { custom: ['kept'] } }],
    localLore: [{ key: 'lore', content: 'Imported lore' }], scriptstate: { score: 7 }, note: 'Imported note' }
  const incoming = backup({ ...chat, _stub: true })
  const prepared = await client.fetch('/api/backup/import/prepare', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ size: incoming.length }),
  })
  expect(prepared.ok).toBe(true)
  const imported = await client.fetch('/api/backup/import', {
    method: 'POST', headers: { 'content-type': 'application/x-risu-backup', accept: 'application/x-ndjson' },
    body: new Uint8Array(incoming),
  })
  expect(imported.ok).toBe(true)
  const events = (await imported.text()).trim().split('\n').map(line => JSON.parse(line))
  expect(events.filter(event => event.type === 'error')).toEqual([])
  expect(events.some(event => event.type === 'done' && event.ok)).toBe(true)

  async function exportedChat() {
    const bytes = await client.exportBackup()
    const entry = decodeBackup(bytes).find(entry => entry.name === 'database.risudat')!
    return (await decodeRisuSave(entry.data)).characters[0].chats[0]
  }
  expect(await exportedChat()).toEqual(chat)

  const rejected = await client.importBackup(backup({ id: chat.id, name: chat.name, _stub: true }))
  expect(rejected.error).toContain('Incomplete chat: hydrate messages before saving canonical files')
  expect(await exportedChat()).toEqual(chat)
})
