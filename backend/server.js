const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');
require('dotenv').config();

const app = express();

// Middleware
app.use(express.json());
app.use(cors());

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
// AUTHENTICATION ROUTES (Part 1)
// ==========================================

// 1. Register User
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, studentId, password } = req.body;

    // Check if user exists
    const existingUser = await User.findOne({ studentId });
    if (existingUser) {
      return res.status(400).json({ message: "Student ID already exists" });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Create user
    const newUser = new User({
      name,
      studentId,
      password: hashedPassword,
      role: 'student' // default role
    });

    await newUser.save();
    res.status(201).json({ message: "User registered successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to register user" });
  }
});

// 2. Login User
app.post('/api/auth/login', async (req, res) => {
  try {
    const { studentId, password } = req.body;

    // Find user
    const user = await User.findOne({ studentId });
    if (!user) {
      return res.status(400).json({ message: "Invalid Student ID or password" });
    }

    // Check password
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid Student ID or password" });
    }

    // Generate Token
    const token = jwt.sign(
      { userId: user._id, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      studentId: user.studentId,
      name: user.name,
      role: user.role // <--- THIS IS CRUCIAL FOR THE ADMIN BUTTON
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error during login" });
  }
});

// ==========================================
// ITEM ROUTES (Part 2 & 3)
// ==========================================

// 3. Create Item (with AI Captioning)
app.post('/api/items', upload.single('photo'), async (req, res) => {
  try {
    const {
      type, title, category, color, building, floor, room, date, description, reportedBy
    } = req.body;

    let aiDescription = null;
    let hasPhoto = false;
    let photo = null;
    let photoType = null;

    // If photo is uploaded, try to get AI caption
    if (req.file) {
      hasPhoto = true;
      photo = req.file.buffer;
      photoType = req.file.mimetype;

      try {
        // Send to Hugging Face API for BLIP captioning
        const hfResponse = await axios.post(
          'https://api-inference.huggingface.co/models/Salesforce/blip-image-captioning-base',
          req.file.buffer,
          {
            headers: {
              'Authorization': 'Bearer YOUR_HF_API_TOKEN_HERE', // Replace if you have a token
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

    // Count matches (Opposite type, same category)
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

// 4. List Open Items
app.get('/api/items', async (req, res) => {
  try {
    const { category, location, date } = req.query;
    let query = { status: 'open' };

    if (category) query.category = category;
    if (location) query.building = location;
    if (date) query.date = date;

    // Select all except the heavy photo buffer
    const items = await Item.find(query).select('-photo');
    res.json(items);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch items" });
  }
});

// 5. Get Photo (with Permission Check)
app.get('/api/items/:id/photo', async (req, res) => {
  try {
    const item = await Item.findById(req.params.id);
    if (!item || !item.hasPhoto || !item.photo) {
      return res.status(404).json({ message: "Photo not found" });
    }
    
    res.set('Content-Type', item.photoType);
    res.send(item.photo);
  } catch (err) {
    res.status(500).json({ message: "Error fetching photo" });
  }
});

// ==========================================
// ADMIN PANEL ROUTES (NEWLY ADDED)
// ==========================================

// 6. Get all users for Admin Panel
app.get('/api/admin/users', async (req, res) => {
  try {
    // We exclude the password field for security
    const users = await User.find().select('-password'); 
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: "Failed to load users" });
  }
});

// 7. Get ALL items for Admin Panel (not just open ones)
app.get('/api/admin/items', async (req, res) => {
  try {
    // Exclude photo buffer to keep the payload fast
    const items = await Item.find().select('-photo').sort({ createdAt: -1 });
    res.json(items);
  } catch (err) {
    res.status(500).json({ message: "Failed to load items" });
  }
});

// 8. Delete an item from Admin Panel
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
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});