import mongoose from 'mongoose'

const configSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    maxlength: 100,
    match: [/^[A-Z0-9_]+$/, 'Config key must contain only uppercase letters, numbers, and underscores'],
  },
  value: {
    type: mongoose.Schema.Types.Mixed,
    required: true,
    validate: {
      validator: (val) => val !== null && val !== undefined && ['string', 'number', 'boolean'].includes(typeof val),
      message: 'Config value must be a string, number, or boolean',
    },
  },
  sensitive: {
    type: Boolean,
    default: false,
  },
  description: {
    type: String,
    trim: true,
  }
}, {
  timestamps: true,
})

const Config = mongoose.model('Config', configSchema)
export default Config
