const mongoose = require('mongoose');

const ItemSchema = new mongoose.Schema({
  type: { type: String, enum: ['lost', 'found'], required: true },
  title: { type: String, required: true },
  category: { type: String, required: true },
  color: { type: String },
  location: { type: String, required: true },
  date: { type: Date, required: true },
  description: { type: String },
  reportedBy: { type: String, required: true }, // We will use the Student ID
  status: { type: String, enum: ['open', 'claimed', 'resolved'], default: 'open' },
  hasPhoto: { type: Boolean, default: false },
  photo: { type: Buffer, select: false },      // image bytes, only loaded when asked
  photoType: { type: String, select: false }   // e.g. image/jpeg
}, { timestamps: true });

module.exports = mongoose.model('Item', ItemSchema);