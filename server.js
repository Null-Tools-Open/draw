import express from 'express'
import { WebSocketServer } from 'ws'
import compression from 'compression'
import dotenv from 'dotenv'
import { initValkey, saveSnapshot, getSnapshot } from './lib/valkey.js'
import { getOrCreateRoom, getRoom, deleteRoom, getRoomCount, startCleanupTimer, closeAllRooms } from './lib/rooms.js'
import { sendDiscordMessage } from './lib/discord.js'

dotenv.config()

const PORT = process.env.PORT
const VALKEY_URL = process.env.VALKEY_URL || 'redis://localhost:6379'
const DRAW_INTERNAL_KEY = process.env.DRAW_INTERNAL_KEY
const ROOM_CLEANUP_MS = parseInt(process.env.ROOM_CLEANUP_MS) || 600000
const MAX_ROOMS = parseInt(process.env.MAX_ROOMS) || 100

const RATE_LIMIT_WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 1000
const RATE_LIMIT_MAX_MESSAGES = parseInt(process.env.RATE_LIMIT_MAX_MESSAGES) || 100

class SlidingWindowRateLimiter {
    constructor(windowMs, maxRequests) {
        this.windowMs = windowMs
        this.maxRequests = maxRequests
        this.timestamps = []
    }

    checkAndRecord() {
        const now = Date.now()
        const windowStart = now - this.windowMs
        this.timestamps = this.timestamps.filter(t => t > windowStart)

        if (this.timestamps.length >= this.maxRequests) {
            const oldestInWindow = this.timestamps[0]
            return {
                allowed: false,
                remaining: 0,
                resetIn: oldestInWindow + this.windowMs - now
            }
        }

        this.timestamps.push(now)
        return {
            allowed: true,
            remaining: this.maxRequests - this.timestamps.length,
            resetIn: this.windowMs
        }
    }

    getUsageLevel() {
        const now = Date.now()
        const windowStart = now - this.windowMs
        this.timestamps = this.timestamps.filter(t => t > windowStart)
        return this.timestamps.length / this.maxRequests
    }
}

if (!DRAW_INTERNAL_KEY) {
    console.error('ERROR: DRAW_INTERNAL_KEY is required')
    process.exit(1)
}

const app = express()
app.use(compression())
app.use(express.json())

initValkey(VALKEY_URL)

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        rooms: getRoomCount(),
        uptime: process.uptime(),
        memory: process.memoryUsage()
    })
})

const server = app.listen(PORT, () => {
    console.log(`[DRAW:MAIN] Running on port ${PORT}`)
    console.log(`[DRAW:MAIN] Protocol: ${process.env.DRAW_PROTOCOL}`)
})

const wss = new WebSocketServer({
    server,
    maxPayload: 1024 * 1024
})

startCleanupTimer(60000, ROOM_CLEANUP_MS)

const MAX_BROADCAST_DATA_SIZE = 512 * 1024

function validateBroadcastData(data) {

    if (typeof data !== 'string') {
        return { valid: false, reason: 'Data must be a string' }
    }

    if (data.length > MAX_BROADCAST_DATA_SIZE) {

        return { valid: false, reason: 'Data exceeds maximum size' }
    }

    if (data.length > 0) {

        const isBase64 = /^[A-Za-z0-9+/=]+$/.test(data)
        const isJson = data.startsWith('{') || data.startsWith('[')

        if (!isBase64 && !isJson) {
            return { valid: false, reason: 'Invalid data format' }
        }
    }

    return { valid: true }
}

wss.on('connection', (ws, req) => {
    let currentRoom = null
    let isAuthenticated = false
    const rateLimiter = new SlidingWindowRateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_MESSAGES)

    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data.toString())

            if (!isAuthenticated) {

                if (message.type !== 'auth') {

                    ws.close(4001, 'Authentication required')

                    return
                }

                if (message.key !== DRAW_INTERNAL_KEY) {
                    ws.close(4003, 'Invalid key')
                    return
                }

                isAuthenticated = true
                ws.send(JSON.stringify({ type: 'auth', status: 'ok' }))
                return
            }

            const rateCheck = rateLimiter.checkAndRecord()
            if (!rateCheck.allowed) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Rate limit exceeded',
                    retryAfter: rateCheck.resetIn
                }))
                ws.close(4029, 'Rate limit exceeded')
                return
            }

            if (rateLimiter.getUsageLevel() > 0.8) {
                console.warn(`[WS] Client ${ws.clientId || 'unknown'} at ${Math.round(rateLimiter.getUsageLevel() * 100)}% rate limit`)
            }

            if (message.type === 'create') {
                const { roomId, clientId } = message

                if (clientId) ws.clientId = clientId

                if (!roomId || typeof roomId !== 'string') {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid roomId' }))
                    return
                }

                if (!/^[a-zA-Z0-9-]+$/.test(roomId)) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid roomId format' }))
                    return
                }

                if (getRoomCount() >= MAX_ROOMS) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Server at capacity' }))
                    return
                }

                if (getRoom(roomId)) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Room already exists' }))
                    return
                }

                sendDiscordMessage({
                    title: '🏠 New Room Created',
                    description: `Room ID: \`${roomId}\``,
                    color: 3447003
                })

                currentRoom = getOrCreateRoom(roomId)
                currentRoom.addClient(ws)

                ws.send(JSON.stringify({
                    type: 'joined',
                    roomId,
                    clients: currentRoom.getClientCount(),
                    isHost: true
                }))

            } else if (message.type === 'join') {
                const { roomId, clientId } = message

                if (clientId) ws.clientId = clientId

                if (!roomId || typeof roomId !== 'string') {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid roomId' }))
                    return
                }

                if (!/^[a-zA-Z0-9-]+$/.test(roomId)) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid roomId format' }))
                    return
                }

                const existingRoom = getRoom(roomId)
                if (!existingRoom) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Room not found' }))
                    return
                }

                currentRoom = existingRoom
                currentRoom.addClient(ws)

                const snapshot = await getSnapshot(roomId)

                if (snapshot) {

                    let data = snapshot
                    let settings = null

                    if (snapshot.startsWith('{')) {
                        try {
                            const parsed = JSON.parse(snapshot)
                            if (parsed && typeof parsed === 'object') {
                                if (parsed.data) data = parsed.data
                                if (parsed.settings) settings = parsed.settings
                            }
                        } catch (e) {
                        }
                    }

                    ws.send(JSON.stringify({
                        type: 'snapshot',
                        data: data,
                        settings: settings
                    }))
                }

                ws.send(JSON.stringify({
                    type: 'joined',
                    roomId,
                    clients: currentRoom.getClientCount(),
                    isHost: currentRoom.isHost(ws)
                }))

                currentRoom.broadcast(JSON.stringify({
                    type: 'peer-joined',
                    clients: currentRoom.getClientCount()
                }), ws)

            } else if (message.type === 'update') {

                if (currentRoom) {

                    if (message.clientId) {
                        ws.clientId = message.clientId
                    }

                    const validation = validateBroadcastData(message.data)

                    if (!validation.valid) {
                        ws.send(JSON.stringify({ type: 'error', message: validation.reason }))
                        return
                    }

                    currentRoom.broadcast(JSON.stringify({
                        type: 'update',
                        data: message.data
                    }), ws)
                }

            } else if (message.type === 'room_settings') {

                if (currentRoom) {

                    currentRoom.broadcast(JSON.stringify({
                        type: 'room_settings',
                        data: message.data
                    }), ws)

                    try {
                        let snapshot = await getSnapshot(currentRoom.id)
                        let data = snapshot
                        let settings = message.data

                        if (snapshot && snapshot.startsWith('{')) {
                            try {
                                const parsed = JSON.parse(snapshot)
                                if (parsed && typeof parsed === 'object') {
                                    if (parsed.data) data = parsed.data
                                }

                            } catch (e) { }
                        }

                        const payload = JSON.stringify({
                            data: data,
                            settings: settings
                        })
                        await saveSnapshot(currentRoom.id, payload)

                    } catch (e) {
                        console.error('Failed to persist room settings', e)
                    }
                }

            } else if (message.type === 'awareness') {

                if (currentRoom) {

                    if (message.clientId) {
                        ws.clientId = message.clientId
                    }

                    const validation = validateBroadcastData(message.data)

                    if (!validation.valid) {
                        ws.send(JSON.stringify({ type: 'error', message: validation.reason }))
                        return
                    }

                    currentRoom.broadcast(JSON.stringify({
                        type: 'awareness',
                        data: message.data
                    }), ws)
                }

            } else if (message.type === 'close_room') {

                if (currentRoom) {
                    sendDiscordMessage({
                        title: '🛑 Room Closed by Host',
                        description: `Room ID: \`${currentRoom.id}\`\nClients connected: ${currentRoom.getClientCount()}`,
                        color: 15548997
                    })
                    currentRoom.closeRoom()
                    currentRoom = null
                }

            } else if (message.type === 'snapshot') {

                if (currentRoom && message.data) {

                    const payload = JSON.stringify({
                        data: message.data,
                        settings: message.settings
                    })
                    await saveSnapshot(currentRoom.id, payload)
                }
            }

        } catch (err) {
            console.error('[WS] Error:', err.message)
            ws.send(JSON.stringify({ type: 'error', message: 'Internal error' }))
        }
    })

    ws.on('close', () => {
        if (currentRoom) {
            currentRoom.removeClient(ws)

            if (currentRoom.getClientCount() === 0) {

            } else {
                currentRoom.broadcast(JSON.stringify({
                    type: 'peer-left',
                    clientId: ws.clientId,
                    clients: currentRoom.getClientCount()
                }))
            }
        }
    })

    ws.on('error', (err) => {
        console.error('[WS] Connection error:', err.message)
    })
})

const gracefulShutdown = (signal) => {
    console.log(`[DRAW:MAIN] ${signal} received, closing...`)
    sendDiscordMessage({
        title: `⛔ ${signal} Received`,
        description: 'Server is shutting down...',
        color: 15105570
    })

    closeAllRooms()
    setTimeout(() => {
        wss.close(() => {
            server.close(() => {
                process.exit(0)
            })
        })
    }, 100)
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'))
process.on('SIGINT', () => gracefulShutdown('SIGINT'))

console.log('[DRAW:MAIN] WebSocket ready')