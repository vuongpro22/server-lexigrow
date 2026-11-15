import { randomUUID } from 'node:crypto'
import AdminMutationLock from '../models/AdminMutationLock.js'
import ErrorResponse from '../utils/ErrorResponse.js'

export async function withAdminMutationLock(operation) {
  const owner = randomUUID()
  const _id = 'admin-user-mutations'
  try {
    // Unique _id is the atomic cross-process lock, including on standalone DBs.
    await AdminMutationLock.create({ _id, owner })
  } catch (error) {
    if (error.code === 11000) {
      throw new ErrorResponse('Đang có thay đổi quyền hoặc trạng thái tài khoản. Vui lòng thử lại.', 409)
    }
    throw error
  }
  try {
    return await operation()
  } finally {
    await AdminMutationLock.deleteOne({ _id, owner })
  }
}
