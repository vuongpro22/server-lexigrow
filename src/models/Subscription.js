import mongoose from 'mongoose'

const subscriptionSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    plan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'SubscriptionPlan',
      required: true,
    },
    planSlug: {
      type: String,
      required: true,
    },
    targetRole: {
      type: String,
      enum: ['student', 'teacher'],
      required: true,
    },
    tier: {
      type: String,
      enum: ['plus', 'pro', 'ultra'],
      required: true,
    },
    billingCycle: {
      type: String,
      enum: ['monthly', 'yearly'],
      required: true,
    },
    amountPaid: {
      type: Number,
      required: true,
      min: 0,
    },
    orderCode: {
      type: Number,
      required: true,
      unique: true,
    },
    activationTransaction: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PaymentTransaction',
      default: null,
    },
    startDate: {
      type: Date,
      default: Date.now,
    },
    endDate: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ['active', 'expired', 'cancelled'],
      default: 'active',
    },
    // Maximum sponsored students allowed if teacher
    maxSponsoredStudents: {
      type: Number,
      default: 0,
    },
    payosTransactionId: {
      type: String,
      default: '',
    },
    // Set only for admin-issued grants. A retried request (double click, network
    // retry) carries the same Idempotency-Key and must not mint a second grant.
    idempotencyKey: {
      type: String,
      default: null,
    },
    requestFingerprint: {
      type: String,
      default: null,
    },
    grantedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  }
)

subscriptionSchema.index({ user: 1, status: 1, endDate: -1 })
subscriptionSchema.index({ activationTransaction: 1 }, { unique: true, partialFilterExpression: { activationTransaction: { $type: 'objectId' } } })
subscriptionSchema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
)

const Subscription = mongoose.model('Subscription', subscriptionSchema)
export default Subscription
