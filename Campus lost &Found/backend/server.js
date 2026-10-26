require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const dns = require('dns');
const multer = require('multer');

// Fix for Windows network DNS issues
dns.setServers(['8.8.8.8']); 

const User = require('./models/User');
const Item = require('./models/Item');

const app = express();

// Allow connections from local files
app.use(cors());
app.use(express.json());

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB successfully!'))
  .catch((err) => console.log('❌ MongoDB connection error:', err));

// Photos are kept in memory, then saved inside the MongoDB item (shared with the whole team)
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/'))
});

// --- AUTH ROUTES ---
app.post('/api/auth/register', async (req, res) => {
  try {
    const { studentId, password } = req.body;
    let user = await User.findOne({ studentId });
    if (user) return res.status(400).json({ message: 'Student ID already exists' });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    user = new User({ studentId, password: hashedPassword });
    await user.save();
    res.status(201).json({ message: 'User registered successfully!' });
  } catch (err) {
    console.log("Register Error:", err); // PRINTS ERROR TO BLACK WINDOW
    res.status(500).json({ message: 'Server error during registration' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { studentId, password } = req.body;
    const user = await User.findOne({ studentId });
    if (!user) return res.status(400).json({ message: 'Invalid Student ID or password' });

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(400).json({ message: 'Invalid Student ID or password' });

    const token = jwt.sign({ _id: user._id, role: user.role }, process.env.JWT_SECRET);
    res.json({ token, studentId: user.studentId, role: user.role });
  } catch (err) {
    console.log("Login Error:", err); // PRINTS ERROR TO BLACK WINDOW
    res.status(500).json({ message: 'Server error during login' });
  }
});

// --- ITEM ROUTES ---
app.post('/api/items', upload.single('photo'), async (req, res) => {
  try {
    const itemData = { ...req.body };
    if (req.file) {
      itemData.photo = req.file.buffer;
      itemData.photoType = req.file.mimetype;
      itemData.hasPhoto = true;
    }
    const newItem = new Item(itemData);
    await newItem.save();
    res.status(201).json({ message: 'Item reported successfully!', id: newItem._id });
  } catch (err) {
    res.status(500).json({ message: 'Failed to report item', error: err.message });
  }
});

// Anyone can view an item's photo
app.get('/api/items/:id/photo', async (req, res) => {
  try {
    const item = await Item.findById(req.params.id).select('+photo +photoType');
    if (!item || !item.photo) return res.status(404).json({ message: 'No photo' });
    res.set('Content-Type', item.photoType || 'image/jpeg');
    res.send(item.photo);
  } catch (err) {
    res.status(500).json({ message: 'Failed to load photo', error: err.message });
  }
});

app.get('/api/items', async (req, res) => {
  try {
    const { type, category, location, date, q, status, reportedBy } = req.query;
    const filter = {};
    if (type) filter.type = type;
    if (category) filter.category = category;
    if (location) filter.location = location;
    if (status) filter.status = status;
    if (reportedBy) filter.reportedBy = reportedBy;

    if (date) {
      const start = new Date(date);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      filter.date = { $gte: start, $lt: end };
    }

    if (q) {
      const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(safe, 'i');
      filter.$or = [{ title: regex }, { description: regex }, { color: regex }];
    }

    const query = Item.find(filter).sort({ createdAt: -1 });
    // Public listings hide the reporter's student ID; the owner's own list (with reportedBy) keeps it
    if (!reportedBy) query.select('-reportedBy');
    const items = await query;
    res.json(items);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch items', error: err.message });
  }
});

// Update an item's status (only the student who reported it can do this)
app.patch('/api/items/:id', async (req, res) => {
  try {
    const { reportedBy, status } = req.body;
    if (!reportedBy) return res.status(400).json({ message: 'reportedBy is required' });
    if (!['open', 'claimed', 'resolved'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }
    const item = await Item.findOneAndUpdate(
      { _id: req.params.id, reportedBy },
      { status },
      { new: true }
    );
    if (!item) return res.status(404).json({ message: 'Item not found or not yours' });
    res.json({ message: 'Status updated', item });
  } catch (err) {
    res.status(500).json({ message: 'Failed to update item', error: err.message });
  }
});

// Delete an item (only the student who reported it can do this)
app.delete('/api/items/:id', async (req, res) => {
  try {
    const { reportedBy } = req.query;
    if (!reportedBy) return res.status(400).json({ message: 'reportedBy is required' });
    const item = await Item.findOneAndDelete({ _id: req.params.id, reportedBy });
    if (!item) return res.status(404).json({ message: 'Item not found or not yours' });
    res.json({ message: 'Item deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete item', error: err.message });
  }
});

// Turn upload/parsing errors (e.g. file too big) into readable JSON messages
app.use((err, req, res, next) => {
  res.status(400).json({ message: err.message || 'Upload failed' });
});

const PORT = 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});