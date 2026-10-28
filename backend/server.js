require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const dns = require('dns');
const multer = require('multer');
const axios = require('axios');

dns.setServers(['8.8.8.8']); 

const User = require('./models/User');
const Item = require('./models/Item');

const app = express();
app.use(cors());
app.use(express.json());

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB successfully!'))
  .catch((err) => console.log('❌ MongoDB connection error:', err));

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, 
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
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
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
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// --- ITEM ROUTES ---

app.post('/api/items', upload.single('photo'), async (req, res) => {
  try {
    const itemData = { ...req.body };
    let aiText = "";

    if (req.file) {
      itemData.photo = req.file.buffer;
      itemData.photoType = req.file.mimetype;
      itemData.hasPhoto = true;

      try {
        const aiResponse = await axios.post(
          "https://api-inference.huggingface.co/models/Salesforce/blip-image-captioning-base",
          req.file.buffer, { headers: { "Content-Type": req.file.mimetype } }
        );
        if (aiResponse.data && aiResponse.data[0] && aiResponse.data[0].generated_text) {
          aiText = aiResponse.data[0].generated_text;
          itemData.aiDescription = aiText;
        }
      } catch (aiError) { console.log("AI failed."); }
    }

    const newItem = new Item(itemData);
    await newItem.save();

    const oppositeType = newItem.type === 'lost' ? 'found' : 'lost';
    let matchQuery = { type: oppositeType, category: newItem.category, status: 'open' };
    if (aiText) {
      matchQuery.aiDescription = { $regex: new RegExp(aiText.split(' ').slice(0, 3).join('|'), 'i') };
    }
    const possibleMatches = await Item.find(matchQuery);

    res.status(201).json({ message: 'Item reported!', matchesFound: possibleMatches.length });
  } catch (err) { res.status(500).json({ message: 'Failed to report item', error: err.message }); }
});

// GET PUBLIC ITEMS (NO PHOTOS, NO DESCRIPTIONS, NO REPORTER ID)
app.get('/api/items', async (req, res) => {
  try {
    // We only select safe fields for the public
    const items = await Item.find({ status: 'open' })
      .select('title type category color building floor room date status')
      .sort({ createdAt: -1 });
    res.json(items);
  } catch (err) { res.status(500).json({ message: 'Failed to fetch items' }); }
});

// GET MY ITEMS & MATCHES
app.get('/api/my-items', async (req, res) => {
  try {
    const { reportedBy } = req.query;
    if (!reportedBy) return res.status(400).json({ message: 'Missing student ID' });
    
    // 1. Get items I reported
    const myItems = await Item.find({ reportedBy }).sort({ createdAt: -1 });
    
    // 2. Get items I claimed
    const claimedItems = await Item.find({ claimedBy: reportedBy });

    // 3. Find potential matches for my open lost/found items
    const myOpenItems = myItems.filter(i => i.status === 'open');
    let matches = [];

    for (let myItem of myOpenItems) {
      const oppositeType = myItem.type === 'lost' ? 'found' : 'lost';
      let matchQuery = { type: oppositeType, category: myItem.category, status: 'open', reportedBy: { $ne: reportedBy } };
      
      if (myItem.aiDescription) {
         matchQuery.aiDescription = { $regex: new RegExp(myItem.aiDescription.split(' ').slice(0, 3).join('|'), 'i') };
      }
      
      const foundMatches = await Item.find(matchQuery);
      // Add a tag so the frontend knows this is a match
      foundMatches.forEach(m => {
        matches.push({ ...m._doc, isMatchFor: myItem.title });
      });
    }

    // Remove duplicates from matches
    const uniqueMatches = Array.from(new Set(matches.map(m => m._id.toString()))).map(id => matches.find(m => m._id.toString() === id));

    res.json({ myItems, claimedItems, matches: uniqueMatches });
  } catch (err) { res.status(500).json({ message: 'Failed to fetch dashboard data' }); }
});

// CLAIM AN ITEM
app.post('/api/items/:id/claim', async (req, res) => {
  try {
    const { claimedBy } = req.body;
    const item = await Item.findByIdAndUpdate(
      req.params.id,
      { status: 'claimed', claimedBy: claimedBy },
      { new: true }
    );
    res.json({ message: 'Item claimed successfully! Please wait for admin verification.', item });
  } catch (err) { res.status(500).json({ message: 'Failed to claim item' }); }
});

// PRIVATE PHOTO ACCESS (Only for dashboard)
app.get('/api/items/:id/photo', async (req, res) => {
  try {
    const item = await Item.findById(req.params.id).select('+photo +photoType');
    if (!item || !item.photo) return res.status(404).json({ message: 'No photo' });
    res.set('Content-Type', item.photoType);
    res.send(item.photo);
  } catch (err) { res.status(500).json({ message: 'Failed to load photo' }); }
});

// DELETE ITEM
app.delete('/api/items/:id', async (req, res) => {
  try {
    const { reportedBy } = req.query;
    const item = await Item.findOneAndDelete({ _id: req.params.id, reportedBy });
    if (!item) return res.status(404).json({ message: 'Not found or unauthorized' });
    res.json({ message: 'Item deleted successfully' });
  } catch (err) { res.status(500).json({ message: 'Failed to delete item' }); }
});

const PORT = 5000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));