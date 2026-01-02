import express from 'express'
import { WebSocketServer } from 'ws'
import compression from 'compression'
import dotenv from 'dotenv'
import { initValkey, saveSnapshot, getSnapshot } from './lib/valkey.js'
import { getOrCreateRoom, getRoom, deleteRoom, getRoomCount, startCleanupTimer } from './lib/rooms.js'

dotenv.config()

const PORT = process.env.PORT
const VALKEY_URL = process.env.VALKEY_URL || 'redis://localhost:6379'
const DRAW_INTERNAL_KEY = process.env.DRAW_INTERNAL_KEY
const ROOM_CLEANUP_MS = parseInt(process.env.ROOM_CLEANUP_MS) || 600000
const MAX_ROOMS = parseInt(process.env.MAX_ROOMS) || 100
const SNAPSHOT_INTERVAL_MS = parseInt(process.env.SNAPSHOT_INTERVAL_MS) || 30000

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

wss.on('connection', (ws, req) => {
    let currentRoom = null
    let isAuthenticated = false
    let messageCount = 0
    let lastMessageTime = Date.now()

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

            const now = Date.now()

            if (now - lastMessageTime < 10) {

                messageCount++

                if (messageCount > 100) {
                    ws.close(4029, 'Rate limit exceeded')
                    return
                }

            } else {
                messageCount = 0
            }
            lastMessageTime = now

            if (message.type === 'join') {
                const { roomId } = message

                if (!roomId || typeof roomId !== 'string') {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid roomId' }))
                    return
                }

                if (getRoomCount() >= MAX_ROOMS && !getRoom(roomId)) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Server at capacity' }))
                    return
                }

                currentRoom = getOrCreateRoom(roomId)
                currentRoom.addClient(ws)

                const snapshot = await getSnapshot(roomId)

                if (snapshot) {
                    ws.send(JSON.stringify({
                        type: 'snapshot',
                        data: snapshot
                    }))
                }

                ws.send(JSON.stringify({
                    type: 'joined',
                    roomId,
                    clients: currentRoom.getClientCount()
                }))

                currentRoom.broadcast(JSON.stringify({
                    type: 'peer-joined',
                    clients: currentRoom.getClientCount()
                }), ws)

            } else if (message.type === 'update') {

                if (currentRoom) {
                    currentRoom.broadcast(JSON.stringify({
                        type: 'update',
                        data: message.data
                    }), ws)
                }

            } else if (message.type === 'awareness') {

                if (currentRoom) {
                    currentRoom.broadcast(JSON.stringify({
                        type: 'awareness',
                        data: message.data
                    }), ws)
                }

            } else if (message.type === 'snapshot') {

                if (currentRoom && message.data) {
                    await saveSnapshot(currentRoom.id, message.data)
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
                    clients: currentRoom.getClientCount()
                }))
            }
        }
    })

    ws.on('error', (err) => {
        console.error('[WS] Connection error:', err.message)
    })
})

process.on('SIGTERM', () => {
    console.log('[DRAW:MAIN] SIGTERM received, closing...')
    wss.close(() => {
        server.close(() => {
            process.exit(0)
        })
    })
})

console.log('[DRAW:MAIN] WebSocket ready')