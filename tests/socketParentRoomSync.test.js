import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  parent: { children: [] },
  links: [],
  classes: [],
  essayIds: [],
}))

vi.mock('../src/models/User.js', () => ({
  default: {
    findById: vi.fn(() => ({
      select: () => ({
        lean: () => Promise.resolve(state.parent),
      }),
    })),
  },
}))

vi.mock('../src/models/ParentStudentLink.js', () => ({
  default: {
    find: vi.fn(() => ({
      select: () => ({
        lean: () => Promise.resolve(state.links),
      }),
    })),
  },
}))

vi.mock('../src/models/Class.js', () => ({
  default: {
    find: vi.fn(() => ({
      select: () => ({
        lean: () => Promise.resolve(state.classes),
      }),
    })),
  },
}))

vi.mock('../src/models/Essay.js', () => ({
  default: {
    find: vi.fn(() => ({
      distinct: () => Promise.resolve(state.essayIds),
    })),
  },
}))

import { applyParentRoomSync } from '../src/services/socket.service.js'

function makeSocket(id, userId, rooms) {
  const socket = {
    id,
    data: { userId },
    user: { children: [] },
    rooms: new Set([id, `user:${userId}`, ...rooms]),
    left: [],
    joined: [],
    join(room) {
      this.rooms.add(room)
      this.joined.push(room)
    },
    leave(room) {
      this.rooms.delete(room)
      this.left.push(room)
    },
  }
  return socket
}

function makeIO(sockets) {
  const emitted = []
  return {
    emitted,
    in(room) {
      return {
        fetchSockets: async () => sockets.filter(socket => socket.rooms.has(room)),
      }
    },
    to(room) {
      return {
        emit(event, payload) {
          emitted.push({ room, event, payload })
        },
      }
    },
  }
}

describe('applyParentRoomSync', () => {
  beforeEach(() => {
    state.parent = { children: [] }
    state.links = []
    state.classes = []
    state.essayIds = []
  })

  it('removes the revoked child, its class and essay rooms while keeping siblings', async () => {
    state.links = [{ student: 'childA' }]
    state.classes = [{ _id: 'classA' }]
    state.essayIds = ['essayB1']

    const socket = makeSocket('socket-1', 'parent1', [
      'user:childA',
      'user:childB',
      'class:classA',
      'class:classB',
      'essay:essayB1',
      'support',
    ])
    const io = makeIO([socket])

    await applyParentRoomSync(io, 'parent1', { revokedStudentId: 'childB' })

    expect(socket.left).toEqual(expect.arrayContaining([
      'user:childB',
      'class:classB',
      'essay:essayB1',
    ]))
    expect(socket.left).not.toContain('user:parent1')
    expect(socket.left).not.toContain('user:childA')
    expect(socket.left).not.toContain('class:classA')
    expect(socket.left).not.toContain('support')

    expect(socket.rooms.has('user:childA')).toBe(true)
    expect(socket.rooms.has('class:classA')).toBe(true)
    expect(socket.rooms.has('user:childB')).toBe(false)
    expect(socket.rooms.has('class:classB')).toBe(false)
    expect(socket.rooms.has('essay:essayB1')).toBe(false)
    expect(socket.rooms.has('support')).toBe(true)

    expect(socket.user.children).toEqual(['childA'])
    expect(socket.data.linkedChildren).toEqual(['childA'])

    expect(io.emitted).toEqual([
      {
        room: 'user:parent1',
        event: 'parent_links_updated',
        payload: { children: ['childA'], revokedStudentId: 'childB' },
      },
    ])
  })

  it('joins a newly linked child and drops every child room when none remain', async () => {
    state.links = [{ student: 'childA' }]
    state.classes = [{ _id: 'classA' }]

    const socket = makeSocket('socket-1', 'parent1', ['support'])
    const io = makeIO([socket])

    await applyParentRoomSync(io, 'parent1')
    expect(socket.joined).toEqual(expect.arrayContaining(['user:childA', 'class:classA']))

    state.links = []
    state.classes = []
    socket.joined.length = 0

    await applyParentRoomSync(io, 'parent1', { revokedStudentId: 'childA' })

    expect(socket.left).toEqual(expect.arrayContaining(['user:childA', 'class:classA']))
    expect(socket.rooms.has('user:childA')).toBe(false)
    expect(socket.rooms.has('class:classA')).toBe(false)
    expect(socket.rooms.has('support')).toBe(true)
    expect(socket.user.children).toEqual([])
    expect(io.emitted.at(-1).payload).toEqual({
      children: [],
      revokedStudentId: 'childA',
    })
  })

  it('evicts rooms from the active link even when User.children is stale', async () => {
    state.parent = { children: ['childB'] }
    state.links = []

    const socket = makeSocket('socket-1', 'parent1', ['user:childB', 'class:classB'])
    const io = makeIO([socket])

    await applyParentRoomSync(io, 'parent1', { revokedStudentId: 'childB' })

    expect(socket.left).toEqual(expect.arrayContaining(['user:childB', 'class:classB']))
    expect(socket.rooms.has('user:childB')).toBe(false)
    expect(socket.rooms.has('class:classB')).toBe(false)
    expect(socket.user.children).toEqual([])
  })
})
