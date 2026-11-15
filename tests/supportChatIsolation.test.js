import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import express from 'express'
import { createServer } from 'node:http'
import { once } from 'node:events'
import mongoose from 'mongoose'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import { io as connect } from 'socket.io-client'
import { MongoMemoryServer } from 'mongodb-memory-server'
import User from '../src/models/User.js'
import ChatMessage from '../src/models/ChatMessage.js'
import { initSocket } from '../src/services/socket.service.js'
import { getChatHistory, sendMessage, markRoomRead } from '../src/controllers/chat.controller.js'

let mongo, server, io, users, clients
const app = express()
app.use(express.json())
app.use((req, res, next) => { req.user = users[req.headers['x-test-user'] || 0]; next() })
app.get('/history/:room', getChatHistory)
app.post('/message', sendMessage)
app.post('/read/:room', markRoomRead)
app.use((err, req, res, next) => { void next; res.status(err.statusCode || 500).json({ message: err.message }) })

beforeAll(async () => {
  mongo = await MongoMemoryServer.create()
  await mongoose.connect(mongo.getUri())
  users = await User.create(['student', 'parent', 'admin'].map((role, i) => ({
    name: role, email: `${i}@test.example`, password: 'Password123!', role,
  })))
  users[1].children = [users[0]._id]
  await users[1].save()
  server = createServer(app)
  io = initSocket(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  clients = users.map(user => connect(`http://127.0.0.1:${server.address().port}`, {
    transports: ['websocket'], auth: { token: jwt.sign({ id: user.id, passwordVersion: user.passwordVersion }, process.env.JWT_SECRET) },
  }))
  await Promise.all(clients.map(client => once(client, 'connect')))
}, 60000)

afterAll(async () => {
  clients?.forEach(client => client.disconnect())
  if (io) await new Promise(resolve => io.close(resolve))
  await mongoose.disconnect()
  await mongo?.stop()
})

describe('ADMIN-01 support conversations', () => {
  it('maps legacy REST support to the owner and blocks foreign history, writes and read markers', async () => {
    await ChatMessage.create({ sender: users[1]._id, room: 'support', content: 'Legacy private information' })
    await request(app).post('/message').send({ room: 'support', content: 'Only A' }).expect(201)
    const history = await request(app).get('/history/support').expect(200)
    expect(history.body.data.map(m => m.content)).toEqual(['Only A'])
    expect(history.body.data[0].room).toBe(`user:${users[0].id}`)
    const otherHistory = await request(app).get('/history/support').set('x-test-user', '1').expect(200)
    expect(otherHistory.body.data).toEqual([])
    const otherRoom = `user:${users[1].id}`
    await request(app).get(`/history/${otherRoom}`).expect(403)
    await request(app).post('/message').send({ room: otherRoom, content: 'Injected' }).expect(403)
    await request(app).post(`/read/${otherRoom}`).expect(403)
    await request(app).post('/message').set('x-test-user', '2').send({ room: `user:${users[0].id}`, content: 'Admin reply' }).expect(201)
    const own = await request(app).get('/history/support').expect(200)
    expect(own.body.data.map(m => m.content)).toEqual(['Only A', 'Admin reply'])
    const legacy = await request(app).get('/history/support').set('x-test-user', '2').expect(200)
    expect(legacy.body.data.map(m => m.content)).toEqual(['Legacy private information'])
  })

  it('isolates legacy socket joins and sends, while admins receive and reply', async () => {
    const [a, b, admin] = clients
    const bMessages = []
    b.on('chat_message', message => bMessages.push(message))
    a.emit('join_chat_room', 'support')
    b.emit('join_chat_room', 'support')
    // Game events must not bypass chat authorization by joining arbitrary rooms.
    a.emit('join_game_room', `chat:user:${users[1].id}`)
    a.emit('join_game_room', 'admin_support')
    const error = once(a, 'error')
    a.emit('join_chat_room', `user:${users[1].id}`)
    await error
    expect(io.sockets.sockets.get(a.id).rooms.has(`chat:user:${users[1].id}`)).toBe(false)
    expect(io.sockets.sockets.get(a.id).rooms.has('admin_support')).toBe(false)
    const rejected = once(a, 'chat_error')
    a.emit('send_chat_message', { room: `user:${users[1].id}`, content: 'Forbidden' })
    await rejected
    const receivedA = once(a, 'chat_message')
    const receivedAdmin = once(admin, 'chat_message')
    a.emit('send_chat_message', { room: 'support', content: 'Socket secret' })
    expect((await receivedA)[0].room).toBe(`user:${users[0].id}`)
    expect((await receivedAdmin)[0].content).toBe('Socket secret')
    const reply = once(a, 'chat_message')
    admin.emit('send_chat_message', { room: `user:${users[0].id}`, content: 'Socket reply' })
    expect((await reply)[0].content).toBe('Socket reply')
    expect(bMessages).toEqual([])
    expect(io.sockets.adapter.rooms.get('support')).toBeUndefined()
    expect(await ChatMessage.countDocuments({ content: 'Forbidden' })).toBe(0)
  })
})
