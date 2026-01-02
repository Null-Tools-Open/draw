import Redis from 'ioredis'

let client = null

export function initValkey(url) {
    const isTls = url.startsWith('rediss://')

    const options = {
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        lazyConnect: false,
    }

    if (isTls) {
        options.tls = {
            rejectUnauthorized: false
        }
    }

    client = new Redis(url, options)

    client.on('error', (err) => {
        console.error('[Valkey] Error:', err.message)
    })

    client.on('connect', () => {
        console.log('[VALKEY:MAIN] Connected')
    })

    return client
}

export async function saveSnapshot(roomId, encryptedData) {
    if (!client) return

    const key = `room:${roomId}:snapshot`
    await client.setex(key, 86400, encryptedData)
}

export async function getSnapshot(roomId) {
    if (!client) return null

    const key = `room:${roomId}:snapshot`
    return await client.get(key)
}

export async function deleteSnapshot(roomId) {
    if (!client) return

    const key = `room:${roomId}:snapshot`
    await client.del(key)
}

export function getClient() {
    return client
}