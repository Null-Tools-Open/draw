import { saveSnapshot } from './valkey.js'

const rooms = new Map()

class Room {
    constructor(roomId) {
        this.id = roomId
        this.clients = new Set()
        this.hostWs = null
        this.lastActivity = Date.now()
        this.snapshotTimer = null
        this.emptyCountdownTimer = null
        this.EMPTY_TIMEOUT_MS = 30000
    }

    addClient(ws) {

        if (this.clients.size === 0) {
            this.hostWs = ws
        }

        this.clients.add(ws)
        this.lastActivity = Date.now()
        console.log(`[Room ${this.id}] Client joined (${this.clients.size} total, host: ${this.hostWs === ws})`)

        if (this.emptyCountdownTimer) {
            clearTimeout(this.emptyCountdownTimer)
            this.emptyCountdownTimer = null
            console.log(`[Room ${this.id}] Empty countdown cancelled - client joined`)
        }
    }

    isHost(ws) {
        return this.hostWs === ws
    }

    removeClient(ws) {
        this.clients.delete(ws)
        this.lastActivity = Date.now()
        console.log(`[Room ${this.id}] Client left (${this.clients.size} remaining)`)

        if (this.clients.size === 0) {
            this.clearSnapshotTimer()
            this.startEmptyCountdown()
        }
    }

    startEmptyCountdown() {
        if (this.emptyCountdownTimer) return

        console.log(`[Room ${this.id}] Starting ${this.EMPTY_TIMEOUT_MS / 1000}s empty countdown...`)

        this.emptyCountdownTimer = setTimeout(() => {
            if (this.clients.size === 0) {
                console.log(`[Room ${this.id}] Empty timeout reached - deleting room`)
                deleteRoom(this.id)
            }
        }, this.EMPTY_TIMEOUT_MS)
    }

    cancelEmptyCountdown() {
        if (this.emptyCountdownTimer) {
            clearTimeout(this.emptyCountdownTimer)
            this.emptyCountdownTimer = null
        }
    }

    closeRoom() {
        console.log(`[Room ${this.id}] Host ended session - notifying all clients`)

        const closeMessage = JSON.stringify({ type: 'room_closed' })
        for (const client of this.clients) {
            if (client.readyState === 1) {
                client.send(closeMessage)
            }
        }

        for (const client of this.clients) {
            client.close(1000, 'Room closed by host')
        }

        this.clients.clear()
        this.cancelEmptyCountdown()
        this.clearSnapshotTimer()

        deleteRoom(this.id)
    }

    broadcast(data, exclude = null) {
        this.lastActivity = Date.now()

        for (const client of this.clients) {
            if (client !== exclude && client.readyState === 1) {
                client.send(data)
            }
        }
    }

    startSnapshotTimer(intervalMs) {
        if (this.snapshotTimer) return

        this.snapshotTimer = setInterval(() => {
            if (this.clients.size === 0) {
                this.clearSnapshotTimer()
            }
        }, intervalMs)
    }

    clearSnapshotTimer() {
        if (this.snapshotTimer) {
            clearInterval(this.snapshotTimer)
            this.snapshotTimer = null
        }
    }

    getClientCount() {
        return this.clients.size
    }
}

export function getOrCreateRoom(roomId) {
    if (!rooms.has(roomId)) {
        rooms.set(roomId, new Room(roomId))
    }
    return rooms.get(roomId)
}

export function getRoom(roomId) {
    return rooms.get(roomId)
}

export function deleteRoom(roomId) {
    const room = rooms.get(roomId)
    if (room) {
        room.clearSnapshotTimer()
        rooms.delete(roomId)
        console.log(`[Room ${roomId}] Deleted`)
    }
}

export function getRoomCount() {
    return rooms.size
}

export function cleanupInactiveRooms(timeoutMs) {
    const now = Date.now()

    for (const [roomId, room] of rooms.entries()) {
        if (room.clients.size === 0 && now - room.lastActivity > timeoutMs) {
            deleteRoom(roomId)
        }
    }
}

export function startCleanupTimer(intervalMs, timeoutMs) {
    setInterval(() => {
        cleanupInactiveRooms(timeoutMs)
    }, intervalMs)
}

export function closeAllRooms() {
    console.log('[ROOMS] Closing all rooms...')
    for (const room of rooms.values()) {
        room.closeRoom()
    }
}