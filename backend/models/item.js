const mongoose = require('mongoose');

const ItemSchema = new mongoose.Schema({
  type: { type: String, enum: ['lost', 'found'], required: true },
  title: { type: String, required: true },
  category: { type: String, required: true },
  color: { type: String },
  
  building: { type: String, required: true },
  floor: { type: String, required: true },
  room: { type: String, required: true },
  
  date: { type: Date, required: true },
  description: { type: String },
  reportedBy: { type: String, required: true }, 
  status: { type: String, enum: ['open', 'claimed', 'resolved'], default: 'open' },
  
  // NEW: Track who claimed it
  claimedBy: { type: String, default: null },
  
  hasPhoto: { type: Boolean, default: false },
  photo: { type: Buffer, select: false }, 
  photoType: { type: String, select: false },
  aiDescription: { type: String, default: "" } 
}, { timestamps: true });

module.exports = mongoose.model('Item', ItemSchema);