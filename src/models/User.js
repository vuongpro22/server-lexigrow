import mongoose from 'mongoose'
import bcrypt from 'bcryptjs'
import { EMAIL_PATTERN, MAX_NAME_LENGTH, MIN_PASSWORD_LENGTH } from '../utils/accountValidation.js'

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please add a name'],
    trim: true,
    maxlength: [MAX_NAME_LENGTH, 'Name cannot be more than 100 characters'],
  },
  email: {
    type: String,
    required: [true, 'Please add an email'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [EMAIL_PATTERN, 'Please add a valid email'],
  },
  password: {
    type: String,
    required: [true, 'Please add a password'],
    minlength: [MIN_PASSWORD_LENGTH, 'Password must be at least 6 characters'],
    select: false, // Don't return password by default
  },
  role: {
    type: String,
    enum: ['student', 'teacher', 'parent', 'admin'],
    default: 'student',
  },
  // Student-specific fields
  learningProfile: {
    interests: { type: [String], default: [] },
    targetLevel: { type: String, enum: ['A2', 'B1', 'B2', 'C1'], default: 'B1' },
    dailyGoalMinutes: { type: Number, enum: [5, 10, 15, 20], default: 10 },
    pace: { type: String, enum: ['standard', 'intensive', 'relaxed'], default: 'standard' },
    onboardingCompleted: { type: Boolean, default: false },
    timezone: { type: String, default: 'Asia/Ho_Chi_Minh' },
  },
  englishLevel: {
    type: String,
    enum: ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', ''],
    default: '',
  },
  anonymousNickname: {
    type: String,
    trim: true,
    default: '',
  },
  // Teacher-specific fields
  institution: {
    type: String,
    trim: true,
    default: '',
  },
  // Parent & Child relationships
  children: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  parents: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  // Shared fields
  avatar: {
    type: String,
    default: '',
  },
  googleId: {
    type: String,
    default: '',
  },
  notifications: {
    email: { type: Boolean, default: true },
    push: { type: Boolean, default: true },
    weekly: { type: Boolean, default: false },
  },
  resetPasswordCode: {
    type: String,
    default: '',
    select: false,
  },
  resetPasswordExpire: {
    type: Date,
    select: false,
  },
  passwordVersion: { type: Number, default: 0 },
  emailChange: {
    type: new mongoose.Schema({
      email: String, originalEmail: String, codeHash: String,
      expiresAt: Date, passwordVersion: Number,
    }, { _id: false }),
    select: false,
  },
  accountStatus: {
    type: String,
    enum: ['active', 'suspended', 'pending_approval', 'rejected', 'deleted'],
    default: 'active',
  },
  statusNote: {
    type: String,
    default: '',
  },
}, {
  timestamps: true,
})

// Admin user list filters on accountStatus + role and sorts by createdAt.
userSchema.index({ accountStatus: 1, role: 1, createdAt: -1 })

// Hash password before saving
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return
  if (!this.isNew) {
    // Compare-and-swap prevents two stale password changes issuing the same
    // version and leaving one of their sessions valid after the other change.
    const previousVersion = this.passwordVersion || 0
    this.$where = { ...this.$where, passwordVersion: previousVersion === 0 ? { $in: [0, null] } : previousVersion }
    this.resetPasswordCode = ''
    this.resetPasswordExpire = undefined
    this.emailChange = undefined
    for (const field of ['resetPasswordCode', 'resetPasswordExpire', 'emailChange']) this.markModified(field)
  }
  this.passwordVersion = this.isNew ? 1 : Math.max(1, this.passwordVersion || 0) + 1
  if (this.isNew && this.$locals.passwordAlreadyHashed) return
  const salt = await bcrypt.genSalt(10)
  this.password = await bcrypt.hash(this.password, salt)
})

userSchema.post('save', function () {
  if (this.$where?.passwordVersion !== undefined) this.$where.passwordVersion = this.passwordVersion
})

userSchema.post('save', function (error, doc, next) {
  if (error.name === 'DocumentNotFoundError' && doc?.$where?.passwordVersion !== undefined) {
    error.statusCode = 409
    error.message = 'Account changed during password update. Please sign in again.'
  }
  next(error)
})

// Only trusted registration code may transfer a stored hash. Regular create/save
// always hashes its input, even if a submitted password looks like a bcrypt hash.
userSchema.statics.createWithPasswordHash = async function (fields) {
  const user = new this(fields)
  user.$locals.passwordAlreadyHashed = true
  return user.save()
}

// Compare entered password with hashed password
userSchema.methods.matchPassword = async function (enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password)
}

const User = mongoose.model('User', userSchema)
export default User
