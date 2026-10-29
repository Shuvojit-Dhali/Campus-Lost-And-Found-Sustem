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
    if (aiText) matchQuery.aiDescription = { $regex: new RegExp(aiText.split(' ').slice(0, 3).join('|'), 'i') };
    const possibleMatches = await Item.find(matchQuery);

    res.status(201).json({ message: 'Item reported!', matchesFound: possibleMatches.length });
  } catch (err) { res.status(500).json({ message: 'Failed to report item', error: err.message }); }
});

app.get('/api/items', async (req, res) => {
  try {
    const items = await Item.find({ status: 'open' }).select('title type category color building floor room date status').sort({ createdAt: -1 });
    res.json(items);
  } catch (err) { res.status(500).json({ message: 'Failed to fetch items' }); }
});

app.get('/api/my-items', async (req, res) => {
  try {
    const { reportedBy } = req.query;
    if (!reportedBy) return res.status(400).json({ message: 'Missing student ID' });
    
    const myItems = await Item.find({ reportedBy }).sort({ createdAt: -1 });
    
    // Items I am trying to claim (Waiting for approval)
    const pendingClaims = await Item.find({ claimRequestedBy: reportedBy, status: 'pending' });
    
    // Items I successfully claimed
    const claimedItems = await Item.find({ claimRequestedBy: reportedBy, status: 'claimed' });

    // AI Matches
    const myOpenItems = myItems.filter(i => i.status === 'open');
    let matches = [];
    for (let myItem of myOpenItems) {
      const oppositeType = myItem.type === 'lost' ? 'found' : 'lost';
      let matchQuery = { type: oppositeType, category: myItem.category, status: 'open', reportedBy: { $ne: reportedBy } };
      if (myItem.aiDescription) {
         matchQuery.aiDescription = { $regex: new RegExp(myItem.aiDescription.split(' ').slice(0, 3).join('|'), 'i') };
      }
      const foundMatches = await Item.find(matchQuery);
      foundMatches.forEach(m => matches.push({ ...m._doc, isMatchFor: myItem.title }));
    }
    const uniqueMatches = Array.from(new Set(matches.map(m => m._id.toString()))).map(id => matches.find(m => m._id.toString() === id));

    // Alerts (If someone requested to claim MY item)
    const alerts = myItems.filter(item => item.status === 'pending');

    res.json({ myItems, pendingClaims, claimedItems, matches: uniqueMatches, alerts });
  } catch (err) { res.status(500).json({ message: 'Failed to fetch dashboard data' }); }
});

// 1. REQUEST A CLAIM (Creates a pending request)
app.post('/api/items/:id/claim', async (req, res) => {
  try {
    const { claimedBy } = req.body;
    const item = await Item.findById(req.params.id);
    
    if (!item) return res.status(404).json({ message: 'Item not found' });
    if (item.status !== 'open') return res.status(400).json({ message: 'Item is no longer available' });

    item.status = 'pending';
    item.claimRequestedBy = claimedBy;
    await item.save();

    res.json({ message: 'Claim request sent! Waiting for the reporter to approve.' });
  } catch (err) { res.status(500).json({ message: 'Failed to process claim' }); }
});

// 2. APPROVE A CLAIM (Reporter accepts)
app.post('/api/items/:id/approve', async (req, res) => {
  try {
    const { ownerId } = req.body;
    const item = await Item.findById(req.params.id);
    
    if (!item || item.reportedBy !== ownerId) return res.status(403).json({ message: 'Unauthorized' });

    item.status = 'claimed'; // Now it's officially claimed
    await item.save();

    res.json({ message: 'Claim approved successfully!' });
  } catch (err) { res.status(500).json({ message: 'Failed to approve' }); }
});

// 3. REJECT A CLAIM (Reporter denies)
app.post('/api/items/:id/reject', async (req, res) => {
  try {
    const { ownerId } = req.body;
    const item = await Item.findById(req.params.id);
    
    if (!item || item.reportedBy !== ownerId) return res.status(403).json({ message: 'Unauthorized' });

    item.status = 'open'; // Back to public
    item.claimRequestedBy = null;
    await item.save();

    res.json({ message: 'Claim rejected.' });
  } catch (err) { res.status(500).json({ message: 'Failed to reject' }); }
});

// 4. SECURE PHOTO ROUTE
app.get('/api/items/:id/photo', async (req, res) => {
  try {
    const requester = req.query.requester; // We pass the requester's ID from the frontend
    const item = await Item.findById(req.params.id).select('+photo +photoType');
    
    if (!item || !item.photo) return res.status(404).json({ message: 'No photo' });

    // SECURITY CHECK: You can only view the photo if:
    // 1. You are the person who reported it
    // 2. You are the person currently requesting to claim it
    // 3. (Optional) You are an admin
    const isOwner = item.reportedBy === requester;
    const isClaimer = item.claimRequestedBy === requester;
    
    if (!isOwner && !isClaimer) {
      return res.status(403).json({ message: 'Private: You do not have permission to view this photo.' });
    }

    res.set('Content-Type', item.photoType);
    res.send(item.photo);
  } catch (err) { res.status(500).json({ message: 'Failed to load photo' }); }
});

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