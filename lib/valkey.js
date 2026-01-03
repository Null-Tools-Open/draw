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

            rejectUnauthorized: true,
        }

        if (process.env.VALKEY_CA_CERT) {
            options.tls.ca = process.env.VALKEY_CA_CERT
            console.log('[VALKEY:TLS] Using custom CA certificate')
        }

        if (process.env.NODE_ENV === 'development' && process.env.VALKEY_ALLOW_SELF_SIGNED === 'true') {
            options.tls.rejectUnauthorized = false
            console.warn('[VALKEY:TLS] WARNING: Self-signed certificates allowed in development mode')
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