import mongoose from 'mongoose'

const schema = new mongoose.Schema({
  _id: String,
  owner: { type: String, required: true },
  acquiredAt: { type: Date, default: Date.now },
})

schema.index({ acquiredAt: 1 })

// Deliberately no TTL: an expired lease cannot fence a delayed User write on
// standalone MongoDB. Never allow two owners to mutate admin membership.
export default mongoose.model('AdminMutationLock', schema)
