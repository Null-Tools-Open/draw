import { saveSnapshot } from './valkey.js'

const rooms = new Map()

class Room {
    constructor(roomId) {
        this.id = roomId
        this.clients = new Set()
        this.lastActivity = Date.now()
        this.snapshotTimer = null
    }

    addClient(ws) {
        this.clients.add(ws)
        this.lastActivity = Date.now()
        console.log(`[Room ${this.id}] Client joined (${this.clients.size} total)`)
    }

    removeClient(ws) {
        this.clients.delete(ws)
        this.lastActivity = Date.now()
        console.log(`[Room ${this.id}] Client left (${this.clients.size} remaining)`)

        if (this.clients.size === 0) {
            this.clearSnapshotTimer()
        }
    }

    broadcast(data, exclude = null) {
        this.lastActivity = Date.now()

        for (const client of this.clients) {
            if (client !== exclude && client.readyState === 1) { // 1 = OPEN
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