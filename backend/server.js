const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
const path = require('path');
require('dotenv').config();

const app = express();

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(cors());

// ==========================================
// SERVE STATIC FILES
// ==========================================
app.use(express.static(path.join(__dirname, '../')));

// ==========================================
// DATABASE CONNECTION & ENVIRONMENT VARIABLES
// ==========================================
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://sabrinamomotaz404_db_user:Vx23iiVpHeD8Vuh3@campusfindcluster.euliyl8.mongodb.net/campus_lost_found?retryWrites=true&w=majority";
const JWT_SECRET = process.env.JWT_SECRET || "campusfind_super_secret_key_2026_change_me";

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch((err) => console.error('❌ MongoDB Connection Error:', err));

// ==========================================
// MODELS
// ==========================================
const User = require('./models/user');
const Item = require('./models/item');

// Multer config (Memory storage for image uploads)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'), false);
    }
  }
});

// ==========================================
// MATCH PERCENTAGE ALGORITHM
// ==========================================
function calculateMatchPercentage(item1, item2) {
  let score = 0;
  let totalPoints = 0;

  // 1. Category match (High importance)
  totalPoints += 40;
  if (item1.category.toLowerCase() === item2.category.toLowerCase()) score += 40;

  // 2. Color match (Medium importance)
  totalPoints += 20;
  if (item1.color && item2.color && item1.color.toLowerCase() === item2.color.toLowerCase()) score += 20;

  // 3. Building match (Medium importance)
  totalPoints += 20;
  if (item1.building.toLowerCase() === item2.building.toLowerCase()) score += 20;

  // 4. Date match (Low importance)
  totalPoints += 20;
  const date1 = new Date(item1.date).toISOString().split('T')[0];
  const date2 = new Date(item2.date).toISOString().split('T')[0];
  if (date1 === date2) score += 20;

  // Calculate percentage (Minimum 40% if they are opposite types in same category)
  let percentage = Math.round((score / totalPoints) * 100);
  
  // Add a little boost if AI descriptions have overlapping words
  if (item1.aiDescription && item2.description) {
      const words1 = item1.aiDescription.toLowerCase().split(' ');
      const words2 = item2.description.toLowerCase().split(' ');
      if (words1.some(w => words2.includes(w) && w.length > 3)) {
          percentage = Math.min(percentage + 10, 99); // Max 99%
      }
  }

  return Math.max(percentage, 45); // Always show at least 45% if category matches
}

// ==========================================
// 1. AUTHENTICATION ROUTES
// ==========================================

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, studentId, password } = req.body;
    const existingUser = await User.findOne({ studentId });
    if (existingUser) return res.status(400).json({ message: "Student ID already exists" });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = new User({ name, studentId, password: hashedPassword, role: 'student' });
    await newUser.save();
    res.status(201).json({ message: "User registered successfully" });
  } catch (err) {
    res.status(500).json({ message: "Failed to register user" });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { studentId, password } = req.body;
    const user = await User.findOne({ studentId });
    if (!user) return res.status(400).json({ message: "Invalid Student ID or password" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: "Invalid Student ID or password" });

    const token = jwt.sign({ userId: user._id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, studentId: user.studentId, name: user.name, role: user.role });
  } catch (err) {
    res.status(500).json({ message: "Server error during login" });
  }
});

// ==========================================
// 2. ITEM & DASHBOARD ROUTES
// ==========================================

app.post('/api/items', upload.single('photo'), async (req, res) => {
  try {
    const { type, title, category, color, building, floor, room, date, description, reportedBy } = req.body;

    let aiDescription = null;
    let hasPhoto = false;
    let photo = null;
    let photoType = null;

    if (req.file) {
      hasPhoto = true;
      photo = req.file.buffer;
      photoType = req.file.mimetype;
      try {
        const hfResponse = await axios.post(
          'https://api-inference.huggingface.co/models/Salesforce/blip-image-captioning-base',
          req.file.buffer,
          { headers: { 'Authorization': 'Bearer YOUR_HF_API_TOKEN_HERE', 'Content-Type': 'application/octet-stream' } }
        );
        if (hfResponse.data && hfResponse.data[0]) aiDescription = hfResponse.data[0].generated_text;
      } catch (aiErr) { console.log('AI failed'); }
    }

    const newItem = new Item({ type, title, category, color, building, floor, room, date, description, reportedBy, aiDescription, hasPhoto, photo, photoType, status: 'open' });
    await newItem.save();

    const matchCount = await Item.countDocuments({ type: type === 'lost' ? 'found' : 'lost', category: category, status: 'open' });
    res.status(201).json({ message: "Item reported successfully", matchedFound: matchCount, item: newItem });
  } catch (err) {
    res.status(500).json({ message: "Failed to report item" });
  }
});

app.get('/api/items', async (req, res) => {
  try {
    const { category, location, date } = req.query;
    let query = { status: 'open' };
    if (category) query.category = category;
    if (location) query.building = location;
    if (date) query.date = date;

    const items = await Item.find(query).select('-photo');
    res.json(items);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch items" });
  }
});

app.get('/api/items/my-items/:studentId', async (req, res) => {
  try {
    const items = await Item.find({ reportedBy: req.params.studentId }).select('-photo').sort({ createdAt: -1 });
    res.json(items);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch your items" });
  }
});

app.delete('/api/items/:id', async (req, res) => {
  try {
    const { studentId } = req.body;
    const item = await Item.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Item not found" });
    if (item.reportedBy !== studentId) return res.status(403).json({ message: "You can only delete your own items" });

    await Item.findByIdAndDelete(req.params.id);
    res.json({ message: "Item deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete item" });
  }
});

// ==========================================
// 3. CLAIM WORKFLOW ROUTES
// ==========================================

app.put('/api/items/:id/confirm-match', async (req, res) => {
  try {
    const { studentId } = req.body;
    const item = await Item.findById(req.params.id);
    if (!item) return res.status(404).json({ message: 'Item not found' });
    if (item.type !== 'found' || item.reportedBy !== studentId) return res.status(403).json({ message: 'Unauthorized' });

    item.matchApproved = true;
    await item.save();
    res.json({ message: 'Match confirmed.', item });
  } catch (err) {
    res.status(500).json({ message: 'Failed to confirm match' });
  }
});

app.put('/api/items/:id/claim', async (req, res) => {
  try {
    const { requester } = req.body;
    const item = await Item.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Item not found" });
    if (item.type === 'found' && !item.matchApproved) return res.status(403).json({ message: "Finder has not confirmed yet." });

    item.status = 'pending';
    item.claimRequestedBy = requester;
    await item.save();
    res.json({ message: "Claim requested successfully", item });
  } catch (err) {
    res.status(500).json({ message: "Failed to request claim" });
  }
});

app.put('/api/items/:id/approve', async (req, res) => {
  try {
    const item = await Item.findById(req.params.id);
    item.status = 'claimed';
    await item.save();
    res.json({ message: "Claim approved", item });
  } catch (err) {
    res.status(500).json({ message: "Failed to approve claim" });
  }
});

app.put('/api/items/:id/reject', async (req, res) => {
  try {
    const item = await Item.findById(req.params.id);
    item.status = 'open';
    item.claimRequestedBy = null;
    await item.save();
    res.json({ message: "Claim rejected", item });
  } catch (err) {
    res.status(500).json({ message: "Failed to reject claim" });
  }
});

// ==========================================
// 4. PHOTO PERMISSION ROUTE
// ==========================================

app.get('/api/items/:id/photo', async (req, res) => {
  try {
    const requester = req.query.requester;
    if (!requester) return res.status(401).json({ message: 'Sign in to view this photo.' });

    const item = await Item.findById(req.params.id).select('+photo +photoType');
    if (!item || !item.hasPhoto || !item.photo) return res.status(404).json({ message: 'Photo not found' });

    const isReporter = item.reportedBy === requester;
    let isApprovedLostOwner = false;

    if (item.type === 'found' && item.matchApproved) {
      isApprovedLostOwner = !!(await Item.findOne({ type: 'lost', reportedBy: requester, category: item.category }).select('_id'));
    }

    const isApprovedClaimant = item.matchApproved && item.claimRequestedBy === requester;
    if (!isReporter && !isApprovedLostOwner && !isApprovedClaimant) {
      return res.status(403).json({ message: 'Permission denied.' });
    }

    res.set('Content-Type', item.photoType || 'application/octet-stream');
    res.send(item.photo);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching photo' });
  }
});

// ==========================================
// 5. ADMIN PANEL ROUTES
// ==========================================

app.get('/api/admin/users', async (req, res) => {
  try { res.json(await User.find().select('-password')); } catch (err) { res.status(500).json({ message: "Error" }); }
});

app.get('/api/admin/items', async (req, res) => {
  try { res.json(await Item.find().select('-photo').sort({ createdAt: -1 })); } catch (err) { res.status(500).json({ message: "Error" }); }
});

app.delete('/api/admin/items/:id', async (req, res) => {
  try {
    await Item.findByIdAndDelete(req.params.id);
    res.json({ message: "Item deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete item" });
  }
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
});