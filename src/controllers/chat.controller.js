import mongoose from 'mongoose'
import ChatMessage from '../models/ChatMessage.js'
import User from '../models/User.js'
import asyncHandler from '../utils/asyncHandler.js'
import ErrorResponse from '../utils/ErrorResponse.js'
import { getIO } from '../services/socket.service.js'
import { canAccessChatRoom, resolveChatRoom } from '../utils/essayAccess.js'

/**
 * @desc    Get chat history for a room
 * @route   GET /api/chat/history/:room
 * @access  Private
 */
export const getChatHistory = asyncHandler(async (req, res) => {
  const room = resolveChatRoom(req.user, req.params.room)
  const { limit = 50, before } = req.query

  // Object-level authorization: admins may read any room; everyone else only
  // the rooms they own or belong to (user:<own>, class/essay rooms).
  if (!(await canAccessChatRoom(req.user, room))) {
    throw new ErrorResponse('Bạn không có quyền truy cập phòng chat này.', 403)
  }

  const query = { room }
  if (before) {
    query.createdAt = { $lt: new Date(before) }
  }

  const messages = await ChatMessage.find(query)
    .populate('sender', 'name email role avatar')
    .sort({ createdAt: -1 })
    .limit(Number(limit))
    .lean()

  const isAdmin = req.user?.role === 'admin'

  // Mark messages as read if recipient is current user (or sent by admin in user's private room)
  if (!isAdmin) {
    const readFilter = room === `user:${req.user._id}`
      ? { room, sender: { $ne: req.user._id }, isRead: false }
      : { room, recipient: req.user._id, isRead: false }
    await ChatMessage.updateMany(
      readFilter,
      { $set: { isRead: true, readAt: new Date() } }
    )
  }

  res.status(200).json({
    success: true,
    count: messages.length,
    data: messages.reverse(), // return in chronological order
  })
})

/**
 * @desc    Send a chat message via REST (fallback for socket)
 * @route   POST /api/chat/message
 * @access  Private
 */
export const sendMessage = asyncHandler(async (req, res) => {
  const { content, recipientId, room } = req.body

  if (!content || content.trim().length === 0) {
    throw new ErrorResponse('Nội dung tin nhắn không được để trống.', 400)
  }

  const senderId = req.user._id
  const isAdmin = req.user.role === 'admin'

  // Determine room
  let targetRoom = room || 'support'
  let recipient = null

  if (recipientId) {
    // Private chat to a specific user (admin to user or user to admin)
    const targetUser = await User.findById(recipientId)
    if (!targetUser) {
      throw new ErrorResponse('Người nhận không tồn tại.', 404)
    }
    // For non-admin, only allow sending to admin or to themselves? Usually chat is support.
    // We'll allow user to send to admin via support room, or admin to user.
    if (!isAdmin && targetUser.role !== 'admin') {
      throw new ErrorResponse('Bạn chỉ có thể nhắn tin với bộ phận hỗ trợ.', 403)
    }
    recipient = recipientId
    // For private chat with admin, room format: user:{userId} of the non-admin participant
    targetRoom = room || (isAdmin ? `user:${recipientId}` : `user:${senderId}`)
  } else if (isAdmin && targetRoom.startsWith('user:')) {
    const roomOwnerId = targetRoom.slice('user:'.length)
    if (roomOwnerId && roomOwnerId !== String(senderId)) {
      recipient = roomOwnerId
    }
  }

  targetRoom = resolveChatRoom(req.user, targetRoom)
  // Authorize the resolved room before storing or broadcasting a message.
  if (!(await canAccessChatRoom(req.user, targetRoom))) {
    throw new ErrorResponse('Bạn không có quyền gửi tin nhắn vào phòng này.', 403)
  }

  const message = await ChatMessage.create({
    sender: senderId,
    recipient: recipient,
    room: targetRoom,
    content: content.trim(),
    isRead: false,
  })

  // Populate sender info for realtime event
  const populated = await message.populate('sender', 'name email role avatar')

  // Emit via socket.io
  const io = getIO()
  // Send to the room
  io.to(`chat:${targetRoom}`).emit('chat_message', populated.toObject())
  // Deliver direct messages to the recipient's personal room too — otherwise a
  // user who never joined targetRoom misses the reply until a page reload.
  if (recipient && String(recipient) !== String(senderId)) {
    io.to(`chat:user:${recipient}`).emit('chat_message', populated.toObject())
  }
  // Also emit to admin support room if this is a support chat
  if (targetRoom === 'support' || targetRoom.startsWith('user:')) {
    io.to('admin_support').emit('chat_message', populated.toObject())
  }

  res.status(201).json({
    success: true,
    data: populated,
  })
})

/**
 * @desc    Get list of chat rooms with unread counts (for admin)
 * @route   GET /api/chat/rooms
 * @access  Private (Admin only)
 */
export const getChatRooms = asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin') {
    throw new ErrorResponse('Chỉ admin mới có quyền xem danh sách phòng chat.', 403)
  }

  // The room list drives an admin sidebar, so the response is capped. The
  // $group and $sort still scan every chat document and materialise one entry
  // per room before $limit trims the list; bounding that scan needs a room
  // summary collection, not another pipeline stage.
  // ponytail: cap only trims the response, add a rooms collection if chat volume grows
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200))

  // Aggregate distinct rooms with unread count
  const adminIds = await User.find({ role: 'admin' }).distinct('_id')
  const rooms = await ChatMessage.aggregate([
    {
      $group: {
        _id: '$room',
        lastMessageAt: { $max: '$createdAt' },
        unreadCount: {
          $sum: { $cond: [{ $and: [{ $eq: ['$isRead', false] }, { $not: [{ $in: ['$sender', adminIds] }] }] }, 1, 0] },
        },
        totalMessages: { $sum: 1 },
      },
    },
    { $sort: { lastMessageAt: -1 } },
    { $limit: limit },
  ])

  // One query for every room owner instead of a findById per room.
  const ownerIds = rooms
    .filter((room) => room._id.startsWith('user:'))
    .map((room) => room._id.slice('user:'.length))
    .filter((id) => mongoose.isValidObjectId(id))
  const owners = ownerIds.length
    ? await User.find({ _id: { $in: ownerIds } }).select('name email role').lean()
    : []
  const ownerById = new Map(owners.map((owner) => [String(owner._id), owner]))

  // Enrich with user info for user rooms
  const enrichedRooms = rooms.map((room) => {
    let user = null
    let roomType = 'support'
    if (room._id.startsWith('user:')) {
      user = ownerById.get(room._id.slice('user:'.length)) || null
      roomType = 'private'
    }
    return {
      room: room._id,
      roomType,
      user,
      lastMessageAt: room.lastMessageAt,
      unreadCount: room.unreadCount,
      totalMessages: room.totalMessages,
    }
  })

  res.status(200).json({
    success: true,
    data: enrichedRooms,
  })
})

/**
 * @desc    Mark all messages in a room as read (for admin)
 * @route   POST /api/chat/rooms/:room/read
 * @access  Private (Admin or room owner)
 */
export const markRoomRead = asyncHandler(async (req, res) => {
  const room = resolveChatRoom(req.user, req.params.room)

  // Object-level authorization: admins may mark any room read; users only
  // rooms they are allowed to access.
  if (!(await canAccessChatRoom(req.user, room))) {
    throw new ErrorResponse('Bạn không có quyền đánh dấu đọc cho phòng này.', 403)
  }

  const adminIds = req.user.role === 'admin' ? await User.find({ role: 'admin' }).distinct('_id') : []
  const result = await ChatMessage.updateMany(
    { room, isRead: false, sender: req.user.role === 'admin' ? { $nin: adminIds } : { $ne: req.user._id } },
    { $set: { isRead: true, readAt: new Date() } }
  )

  res.status(200).json({
    success: true,
    message: `Đã đánh dấu ${result.modifiedCount} tin nhắn là đã đọc.`,
    modifiedCount: result.modifiedCount,
  })
})
