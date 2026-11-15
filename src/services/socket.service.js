import { Server } from 'socket.io'
import jwt from 'jsonwebtoken'
import User from '../models/User.js'
import Class from '../models/Class.js'
import ParentStudentLink from '../models/ParentStudentLink.js'
import ChatMessage from '../models/ChatMessage.js'
import Essay from '../models/Essay.js'
import gameCleanupService from './gameCleanup.service.js'
import { canAccessEssay, canAccessChatRoom, resolveChatRoom } from '../utils/essayAccess.js'
import { parseCookies } from '../utils/cookie.js'

let io = null

/**
 * Initialize Socket.io server
 * @param {Object} server - HTTP Server instance
 */
export const initSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: process.env.CLIENT_URL || 'http://localhost:5173',
      methods: ['GET', 'POST'],
      credentials: true,
    }
  })

  // Middleware to authenticate socket connection using JWT token or HttpOnly cookie
  io.use(async (socket, next) => {
    try {
      let token = socket.handshake.auth?.token || socket.handshake.query?.token

      if (!token && socket.handshake.headers?.cookie) {
        const cookies = parseCookies(socket.handshake.headers.cookie)
        token = cookies.token
      }

      if (!token || token === 'none') {
        return next(new Error('Authentication error: Token missing'))
      }

      let jwtToken = token
      if (token.startsWith('Bearer ')) {
        jwtToken = token.split(' ')[1]
      }

      const decoded = jwt.verify(jwtToken, process.env.JWT_SECRET)
      const user = await User.findById(decoded.id)
      if (!user) {
        return next(new Error('Authentication error: User not found'))
      }
      if (user.accountStatus && user.accountStatus !== 'active') {
        return next(new Error('Authentication error: Account is not active'))
      }
      if (decoded.passwordVersion === undefined
        ? (user.passwordVersion || 0) > 1
        : decoded.passwordVersion !== (user.passwordVersion || 0)) {
        return next(new Error('Authentication error: Session expired'))
      }

      socket.user = user
      socket.data.userId = user._id.toString()
      next()
    } catch (err) {
      console.error('Socket auth error:', err.message)
      next(new Error('Authentication error: Invalid token'))
    }
  })

  io.on('connection', async (socket) => {
    const userId = socket.user._id.toString()
    const userRole = socket.user.role
    console.log(`🔌 Socket connected: User ${userId} (${userRole})`)

    socket.use(async (_packet, next) => {
      try {
        const current = await User.findById(userId).select('accountStatus role passwordVersion children')
        if (!current || current.accountStatus !== 'active' || current.role !== userRole ||
          (current.passwordVersion || 0) !== (socket.user.passwordVersion || 0)) {
          socket.disconnect(true)
          return
        }
        // Parent-child links can be revoked while this socket stays open
        // (another tab/device unlinks). Refresh the snapshot used by
        // canAccessEssay / canAccessChatRoom on every packet so a stale
        // handshake-time children array never grants access.
        if (userRole === 'parent') {
          socket.user.children = current.children || []
        }
        next()
      } catch (error) {
        next(error)
      }
    })

    // Join personal room for user-targeted notifications
    socket.join(`user:${userId}`)
    // Chat delivery must not use notification rooms, which parents may share.
    socket.join(`chat:user:${userId}`)
    if (userRole === 'admin') socket.join('admin_support')

    // Join classes rooms for class-wide notifications
    try {
      let classes = []
      if (userRole === 'teacher') {
        classes = await Class.find({ teacher: userId })
      } else if (userRole === 'student') {
        classes = await Class.find({ students: userId })
      } else if (userRole === 'parent') {
        // Parent rooms are derived from active ParentStudentLink rows, not the
        // denormalised User.children array, so a revoked link cannot rejoin
        // child rooms after reconnecting with a stale user document.
        const links = await ParentStudentLink.find({ parent: userId, status: 'active' })
          .select('student')
          .lean()
        const childrenIds = [...new Set(
          links.map(link => String(link.student?._id || link.student || '')).filter(Boolean),
        )]
        socket.user.children = childrenIds
        socket.data.linkedChildren = childrenIds

        if (childrenIds.length > 0) {
          classes = await Class.find({ students: { $in: childrenIds } })
          for (const childId of childrenIds) {
            const childRoom = `user:${childId}`
            socket.join(childRoom)
            console.log(`👨‍👩‍👦 Parent ${userId} joined child room: ${childRoom}`)
          }
        }
      }

      for (const cls of classes) {
        const classRoom = `class:${cls._id.toString()}`
        socket.join(classRoom)
        console.log(`🏫 User ${userId} joined class room: ${classRoom}`)
      }
    } catch (error) {
      console.error(`Error joining rooms for user ${userId}:`, error)
    }

    socket.on('join_essay_comments', async (essayId) => {
      try {
        const Essay = (await import('../models/Essay.js')).default
        const essay = await Essay.findById(essayId).select('student status class assignment')
        if (!essay || !(await canAccessEssay(socket.user, essay))) {
          socket.emit('error', { message: 'Unauthorized' })
          return
        }
        socket.join(`essay:${essayId}`)
        console.log(`💬 User ${userId} joined essay comment room: essay:${essayId}`)
      } catch (err) {
        console.error('join_essay_comments error:', err.message)
        socket.emit('error', { message: 'Unauthorized' })
      }
    })

    socket.on('leave_essay_comments', (essayId) => {
      socket.leave(`essay:${essayId}`)
      console.log(`💬 User ${userId} left essay comment room: essay:${essayId}`)
    })

    // Chat event: send message
    socket.on('send_chat_message', async (data) => {
      try {
        const { content, recipientId, room } = data
        if (!content || content.trim().length === 0) {
          return socket.emit('chat_error', { message: 'Nội dung tin nhắn không được để trống.' })
        }

        const senderId = userId
        const isAdmin = userRole === 'admin'

        let targetRoom = room || 'support'
        let recipient = null

        if (recipientId) {
          const targetUser = await User.findById(recipientId)
          if (!targetUser) {
            return socket.emit('chat_error', { message: 'Người nhận không tồn tại.' })
          }
          if (!isAdmin && targetUser.role !== 'admin') {
            return socket.emit('chat_error', { message: 'Bạn chỉ có thể nhắn tin với bộ phận hỗ trợ.' })
          }
          recipient = recipientId
          targetRoom = room || (isAdmin ? `user:${recipientId}` : `user:${senderId}`)
        } else if (isAdmin && targetRoom.startsWith('user:')) {
          const roomOwnerId = targetRoom.slice('user:'.length)
          if (roomOwnerId && roomOwnerId !== String(senderId)) {
            recipient = roomOwnerId
          }
        }
        targetRoom = resolveChatRoom(socket.user, targetRoom)
        // LG-10/LG-11: object-level authorization — never let a client inject
        // messages into a room they do not belong to (class:*, essay:*, user:*).
        if (!(await canAccessChatRoom(socket.user, targetRoom))) {
          return socket.emit('chat_error', { message: 'Bạn không có quyền gửi tin nhắn vào phòng này.' })
        }

        // Save to DB
        const message = await ChatMessage.create({
          sender: senderId,
          recipient: recipient,
          room: targetRoom,
          content: content.trim(),
          isRead: false,
        })

        // Populate sender info
        await message.populate('sender', 'name email role avatar')

        // Emit to room
        const io = getIO()
        io.to(`chat:${targetRoom}`).emit('chat_message', message.toObject())
        // Deliver direct messages to the recipient's personal room too — otherwise
        // a user-to-user reply only lands in the sender's own room and is lost.
        if (recipient && recipient.toString() !== senderId) {
          io.to(`chat:user:${recipient.toString()}`).emit('chat_message', message.toObject())
        }
        if (targetRoom === 'support' || targetRoom.startsWith('user:')) {
          io.to('admin_support').emit('chat_message', message.toObject())
        }
      } catch (error) {
        console.error('Chat send error:', error)
        socket.emit('chat_error', { message: 'Lỗi gửi tin nhắn.' })
      }
    })

    socket.on('join_chat_room', async (room) => {
      try {
        room = resolveChatRoom(socket.user, room)
        if (!(await canAccessChatRoom(socket.user, room))) {
          socket.emit('error', { message: 'Unauthorized' })
          return
        }
        socket.join(`chat:${room}`)
        console.log(`💬 User ${userId} joined chat room: ${room}`)
      } catch (err) {
        console.error('join_chat_room error:', err.message)
        socket.emit('error', { message: 'Unauthorized' })
      }
    })

    // Admin joins support room automatically (already done above)
    // But we need to ensure admin_support room is created
    // This is handled in the connection logic above, but we also add an explicit join for admin if not already.
    // Non-admin support requests resolve to the user's private room.

    socket.on('join_game_room', (roomId) => {
      if (typeof roomId !== 'string' || !roomId.startsWith('game:')) return
      gameCleanupService.joinGameRoom(socket, roomId)
      console.log(`🎮 User ${userId} joined game room: ${roomId}`)
    })

    socket.on('leave_game_room', (roomId) => {
      if (typeof roomId !== 'string' || !roomId.startsWith('game:')) return
      gameCleanupService.leaveGameRoom(socket, roomId)
      console.log(`🎮 User ${userId} left game room: ${roomId}`)
    })

    socket.on('disconnect', () => {
      gameCleanupService.cleanupSocket(socket)
      console.log(`🔌 Socket disconnected & resources cleaned up: User ${userId}`)
    })
  })

  return io
}

/**
 * Emit event to a specific user room
 * @param {string} userId
 * @param {Object} notification
 */
export const sendNotificationToUser = (userId, notification) => {
  if (io) {
    io.to(`user:${userId}`).emit('notification', notification)
    console.log(`📡 Emitted notification to user:${userId}`)
  } else {
    console.warn('Socket.io server not initialized. Failed to send notification.')
  }
}

export const disconnectUserSockets = async (userId) => {
  if (!io) return
  const id = String(userId)
  const sockets = await io.in(`user:${id}`).fetchSockets()
  for (const socket of sockets) {
    if (socket.data.userId === id) socket.disconnect(true)
  }
}

/**
 * Rebuild the rooms of every connected session of a parent after their
 * parent-child links change. Exported separately so it can be tested with a
 * fake Socket.IO server.
 *
 * Parents join `user:<childId>` (child notifications), the children's
 * `class:<classId>` rooms, and possibly `essay:<essayId>` comment rooms.
 * Those joins are computed at connection time, so unlink must explicitly
 * remove the now-forbidden rooms instead of waiting for a reconnect.
 *
 * @param {Object} ioServer - Socket.IO server (or a compatible test double)
 * @param {string|ObjectId} parentId
 * @param {{ revokedStudentId?: string|ObjectId }} [options]
 */
export const applyParentRoomSync = async (ioServer, parentId, { revokedStudentId } = {}) => {
  const id = String(parentId)
  const [links, sockets] = await Promise.all([
    ParentStudentLink.find({ parent: id, status: 'active' }).select('student').lean(),
    ioServer.in(`user:${id}`).fetchSockets(),
  ])

  const childIds = [...new Set(
    (links || [])
      .map(link => String(link.student?._id || link.student || ''))
      .filter(Boolean),
  )]
  const allowedChildRooms = new Set(childIds.map(childId => `user:${childId}`))

  const classes = childIds.length
    ? await Class.find({ students: { $in: childIds } }).select('_id').lean()
    : []
  const allowedClassRooms = new Set(classes.map(cls => `class:${cls._id}`))

  let revokedEssayRooms = new Set()
  if (revokedStudentId) {
    const essayIds = await Essay.find({ student: revokedStudentId }).distinct('_id')
    revokedEssayRooms = new Set(essayIds.map(essayId => `essay:${essayId}`))
  }

  for (const socket of sockets) {
    if (String(socket.data?.userId || '') !== id) continue

    socket.data.linkedChildren = childIds
    if (socket.user) socket.user.children = childIds

    for (const room of [...socket.rooms]) {
      if (room === `user:${id}`) continue
      const isStaleChildRoom = room.startsWith('user:') && !allowedChildRooms.has(room)
      const isStaleClassRoom = room.startsWith('class:') && !allowedClassRooms.has(room)
      if (isStaleChildRoom || isStaleClassRoom || revokedEssayRooms.has(room)) {
        socket.leave(room)
      }
    }

    // Re-join everything the parent is still entitled to (idempotent).
    for (const childId of childIds) socket.join(`user:${childId}`)
    for (const cls of classes) socket.join(`class:${cls._id}`)
  }

  ioServer.to(`user:${id}`).emit('parent_links_updated', {
    children: childIds,
    ...(revokedStudentId ? { revokedStudentId: String(revokedStudentId) } : {}),
  })
}

/**
 * Same as applyParentRoomSync, using the live server instance. Failures are
 * logged but never bubble into an unlink/approval response: the database is
 * already updated at this point.
 */
export const syncParentLinkedRooms = async (parentId, options = {}) => {
  if (!io) return
  try {
    await applyParentRoomSync(io, parentId, options)
  } catch (error) {
    console.error(`[socket] Failed to sync parent rooms for ${parentId}:`, error.message)
  }
}

/**
 * Emit event to a specific class room
 * @param {string} classId
 * @param {Object} notification
 */
export const sendNotificationToClass = (classId, notification) => {
  if (io) {
    io.to(`class:${classId}`).emit('notification', notification)
    console.log(`📡 Emitted notification to class:${classId}`)
  } else {
    console.warn('Socket.io server not initialized. Failed to send notification.')
  }
}

/**
 * Broadcast event to everyone
 * @param {Object} notification
 */
export const broadcastNotification = (notification) => {
  if (io) {
    io.emit('notification', notification)
    console.log('📡 Broadcasted notification to everyone')
  } else {
    console.warn('Socket.io server not initialized. Failed to send notification.')
  }
}

/**
 * Accessor for the io server instance
 * @returns {Object}
 */
export const getIO = () => {
  if (!io) {
    throw new Error('Socket.io not initialized')
  }
  return io
}
