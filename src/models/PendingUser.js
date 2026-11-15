import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'
import { EMAIL_PATTERN, MAX_NAME_LENGTH, MIN_PASSWORD_LENGTH } from '../utils/accountValidation.js'

const pendingUserSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please add a name'],
    trim: true,
    maxlength: [MAX_NAME_LENGTH, 'Name cannot be more than 100 characters'],
  },
  email: {
    type: String,
    required: [true, 'Please add an email'],
    lowercase: true,
    trim: true,
    match: [EMAIL_PATTERN, 'Please add a valid email'],
  },
  password: {
    type: String,
    required: [true, 'Please add a password'],
    minlength: [MIN_PASSWORD_LENGTH, 'Password must be at least 6 characters'],
  },
  // Explicit marker keeps registrations created before hashing was introduced usable.
  passwordHashed: { type: Boolean, default: false },
  role: {
    type: String,
    enum: ['student', 'teacher', 'parent'],
    default: 'student',
  },
  englishLevel: {
    type: String,
    enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', ''],
    default: '',
  },
  institution: {
    type: String,
    trim: true,
    default: '',
  },
  verificationCode: {
    type: String,
    required: true,
  },
  verificationCodeExpire: {
    type: Date,
    required: true,
  },
}, {
  timestamps: true,
})

pendingUserSchema.pre('save', async function () {
  if (!this.isModified('password')) return
  this.password = await bcrypt.hash(this.password, 10)
  this.passwordHashed = true
})

// Resending an OTP extends the lifetime of the registration itself.
pendingUserSchema.index({ verificationCodeExpire: 1 }, { expireAfterSeconds: 0 })
pendingUserSchema.index({ email: 1 }, { unique: true, name: 'pending_email_unique' })

const PendingUser = mongoose.model('PendingUser', pendingUserSchema)
export default PendingUser
