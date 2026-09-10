import { afterAll, describe, expect, test } from 'vitest'
import { createCipheriv, createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createClient } from './helpers/client.js'
import { decodeBackup } from './helpers/decode.js'
import { encodeBackup } from './helpers/encode.js'
import { normalizeBackup } from './helpers/normalize.js'
import { createSeedBackup } from './helpers/seed.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'

const servers: ServerHandle[] = []
const keyServers: Server[] = []

afterAll(async () => {
  await Promise.allSettled(servers.map(server => server.cleanup()))
  await Promise.allSettled(keyServers.map(server => new Promise<void>((resolve) => server.close(() => resolve()))))
})

async function startAccountKeyServer(time: number, key: string): Promise<string> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/cryptokey' || url.searchParams.get('key') !== String(time)) {
      res.writeHead(404).end()
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ key }))
  })
  keyServers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}/cryptokey`
}

function createEncryptedAccountBackup(seed: Buffer, time: number, key: string): Buffer {
  const database = decodeBackup(seed).find(entry => entry.name === 'database.risudat')
  if (!database) throw new Error('Seed backup is missing database.risudat')

  const cipher = createCipheriv(
    'aes-256-gcm',
    createHash('sha256').update(key).digest(),
    Buffer.alloc(12),
  )
  const encrypted = Buffer.concat([
    cipher.update(database.data),
    cipher.final(),
    cipher.getAuthTag(),
  ])

  return encodeBackup([
    {
      name: 'encryption.risudat',
      data: Buffer.from(JSON.stringify({ time, type: 'account' }), 'utf-8'),
    },
    { name: 'database.risudat', data: encrypted },
  ])
}

describe('account backup import', () => {
  test('decrypts and imports an upstream account backup', async () => {
    const time = 1_788_000_000_000
    const key = 'account-backup-test-key'
    const keyEndpoint = await startAccountKeyServer(time, key)
    const seed = createSeedBackup({ characterCount: 2 })
    const encrypted = createEncryptedAccountBackup(seed, time, key)
    const server = await spawnServer({
      env: { RISUBARD_ACCOUNT_BACKUP_KEY_ENDPOINT: keyEndpoint },
    })
    servers.push(server)
    const client = await createClient(server.port, server.password)

    const result = await client.importBackup(encrypted)
    expect(result).toMatchObject({ ok: true, assetsRestored: 0 })

    const exported = await client.exportBackup()
    const expected = normalizeBackup(seed).normalized
    expected.settingKeys = [...new Set([...expected.settingKeys, 'modules', 'loreBook'])].sort()
    expect(normalizeBackup(exported).normalized).toEqual(expected)
  })

  test('rejects an invalid database without replacing the active database', async () => {
    const server = await spawnServer()
    servers.push(server)
    const client = await createClient(server.port, server.password)
    const seed = createSeedBackup({ characterCount: 2, chatsPerCharacter: 2 })

    expect(await client.importBackup(seed)).toMatchObject({ ok: true })
    const before = normalizeBackup(await client.exportBackup()).normalized

    const invalid = encodeBackup([
      { name: 'database.risudat', data: Buffer.from('not-a-risu-database', 'utf-8') },
    ])
    const result = await client.importBackup(invalid)
    expect(result.error).toBeTypeOf('string')

    const after = normalizeBackup(await client.exportBackup()).normalized
    expect(after).toEqual(before)
  })
})
