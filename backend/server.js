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
// SERVE STATIC FILES (HTML, CSS, JS)
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
// 1. AUTHENTICATION ROUTES
// ==========================================

// Register User
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, studentId, password } = req.body;

    const existingUser = await User.findOne({ studentId });
    if (existingUser) {
      return res.status(400).json({ message: "Student ID already exists" });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = new User({
      name,
      studentId,
      password: hashedPassword,
      role: 'student'
    });

    await newUser.save();
    res.status(201).json({ message: "User registered successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to register user" });
  }
});

// Login User
app.post('/api/auth/login', async (req, res) => {
  try {
    const { studentId, password } = req.body;

    const user = await User.findOne({ studentId });
    if (!user) {
      return res.status(400).json({ message: "Invalid Student ID or password" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid Student ID or password" });
    }

    const token = jwt.sign(
      { userId: user._id, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      studentId: user.studentId,
      name: user.name,
      role: user.role
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error during login" });
  }
});

// ==========================================
// 2. ITEM & DASHBOARD ROUTES
// ==========================================

// Create Item
app.post('/api/items', upload.single('photo'), async (req, res) => {
  try {
    const {
      type, title, category, color, building, floor, room, date, description, reportedBy
    } = req.body;

    let aiDescription = null;
    let hasPhoto = false;
    let photo = null;
    let photoType = null;

    if (req.file) {
      hasPhoto = true;
      photo = req.file.buffer;
      photoType = req.file.mimetype;

      // AI Captioning (using Hugging Face)
      try {
        const hfResponse = await axios.post(
          'https://api-inference.huggingface.co/models/Salesforce/blip-image-captioning-base',
          req.file.buffer,
          {
            headers: {
              'Authorization': 'Bearer YOUR_HF_API_TOKEN_HERE',
              'Content-Type': 'application/octet-stream'
            }
          }
        );
        if (hfResponse.data && hfResponse.data[0]) {
          aiDescription = hfResponse.data[0].generated_text;
        }
      } catch (aiErr) {
        console.log('AI captioning failed, saving item without caption.');
      }
    }

    const newItem = new Item({
      type, title, category, color, building, floor, room, date, description,
      reportedBy, aiDescription, hasPhoto, photo, photoType, status: 'open'
    });

    await newItem.save();

    // Count matches for response
    const matchCount = await Item.countDocuments({
      type: type === 'lost' ? 'found' : 'lost',
      category: category,
      status: 'open'
    });

    res.status(201).json({
      message: "Item reported successfully",
      matchedFound: matchCount,
      item: newItem
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to report item" });
  }
});

// List Open Items (with filters)
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

// Get User's Own Items (My Items)
app.get('/api/items/my-items/:studentId', async (req, res) => {
  try {
    const items = await Item.find({ reportedBy: req.params.studentId }).select('-photo').sort({ createdAt: -1 });
    res.json(items);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch your items" });
  }
});

// Delete Own Item
app.delete('/api/items/:id', async (req, res) => {
  try {
    const { studentId } = req.body;
    const item = await Item.findById(req.params.id);

    if (!item) return res.status(404).json({ message: "Item not found" });
    if (item.reportedBy !== studentId) {
      return res.status(403).json({ message: "You can only delete your own items" });
    }

    await Item.findByIdAndDelete(req.params.id);
    res.json({ message: "Item deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete item" });
  }
});

// ==========================================
// 3. CLAIM WORKFLOW ROUTES
// ==========================================

// Confirm Match (only the person who reported the found item can confirm)
app.put('/api/items/:id/confirm-match', async (req, res) => {
  try {
    const { studentId } = req.body;
    const item = await Item.findById(req.params.id);
    if (!item) return res.status(404).json({ message: 'Item not found' });
    if (item.type !== 'found' || item.reportedBy !== studentId) {
      return res.status(403).json({ message: 'Only the person who reported this found item can confirm the match.' });
    }
    item.matchApproved = true;
    await item.save();
    res.json({ message: 'Match confirmed. The lost-item reporter can now view the photo and request the item.', item });
  } catch (err) {
    res.status(500).json({ message: 'Failed to confirm match' });
  }
});

// Claim Item (Requires matchApproved = true)
app.put('/api/items/:id/claim', async (req, res) => {
  try {
    const { requester } = req.body;
    const item = await Item.findById(req.params.id);

    if (!item) return res.status(404).json({ message: "Item not found" });
    
    if (item.type === 'found' && !item.matchApproved) {
      return res.status(403).json({ message: "The finder has not confirmed this match yet. You cannot claim it." });
    }

    item.status = 'pending';
    item.claimRequestedBy = requester;
    await item.save();

    res.json({ message: "Claim requested successfully", item });
  } catch (err) {
    res.status(500).json({ message: "Failed to request claim" });
  }
});

// Approve Claim (Reporter approves)
app.put('/api/items/:id/approve', async (req, res) => {
  try {
    const item = await Item.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Item not found" });

    item.status = 'claimed';
    await item.save();

    res.json({ message: "Claim approved", item });
  } catch (err) {
    res.status(500).json({ message: "Failed to approve claim" });
  }
});

// Reject Claim (Reporter rejects)
app.put('/api/items/:id/reject', async (req, res) => {
  try {
    const item = await Item.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Item not found" });

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
    if (!item || !item.hasPhoto || !item.photo) {
      return res.status(404).json({ message: 'Photo not found' });
    }

    const isReporter = item.reportedBy === requester;
    let isApprovedLostOwner = false;

    if (item.type === 'found' && item.matchApproved) {
      isApprovedLostOwner = !!(await Item.findOne({
        type: 'lost',
        reportedBy: requester,
        category: item.category
      }).select('_id'));
    }

    const isApprovedClaimant = item.matchApproved && item.claimRequestedBy === requester;
    if (!isReporter && !isApprovedLostOwner && !isApprovedClaimant) {
      return res.status(403).json({ message: 'The found-item reporter must confirm this match before you can view the photo.' });
    }

    res.set('Content-Type', item.photoType || 'application/octet-stream');
    res.set('Cache-Control', 'no-store');
    res.send(item.photo);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching photo' });
  }
});

// ==========================================
// 5. ADMIN PANEL ROUTES
// ==========================================

app.get('/api/admin/users', async (req, res) => {
  try {
    const users = await User.find().select('-password'); 
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: "Failed to load users" });
  }
});

app.get('/api/admin/items', async (req, res) => {
  try {
    const items = await Item.find().select('-photo').sort({ createdAt: -1 });
    res.json(items);
  } catch (err) {
    res.status(500).json({ message: "Failed to load items" });
  }
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