import ParentStudentLink from '../models/ParentStudentLink.js'
import User from '../models/User.js'

/**
 * Activate a parent-student link in an idempotent way.
 *
 * The link flow can be reached from two directions at the same time:
 *  - a parent submits a one-time code (POST /api/parent/link)
 *  - a student approves a pending parent verification request
 *
 * Both paths must tolerate a concurrent insert of the same
 * (parent, student) pair. The unique index is the final arbiter; when it
 * rejects the duplicate we re-read the winner and activate that row instead
 * of failing the request with a 500.
 */
export async function activateParentStudentLink({ parentId, studentId, relationship }) {
  const applyActiveState = async (link) => {
    if (relationship) link.relationship = relationship
    link.status = 'active'
    link.linkedAt = new Date()
    link.revokedAt = null
    link.revokedBy = null
    await link.save()
    return link
  }

  let link = await ParentStudentLink.findOne({ parent: parentId, student: studentId })

  if (link) {
    await applyActiveState(link)
  } else {
    try {
      link = await ParentStudentLink.create({
        parent: parentId,
        student: studentId,
        relationship: relationship || 'guardian',
      })
    } catch (error) {
      if (error.code !== 11000) throw error
      link = await ParentStudentLink.findOne({ parent: parentId, student: studentId })
      if (!link) throw error
      await applyActiveState(link)
    }
  }

  // Keep the denormalised arrays in sync. $addToSet makes this safe to run
  // again when a client retries a request that already succeeded.
  await Promise.all([
    User.updateOne({ _id: parentId }, { $addToSet: { children: studentId } }),
    User.updateOne({ _id: studentId }, { $addToSet: { parents: parentId } }),
  ])

  return link
}

export default { activateParentStudentLink }
