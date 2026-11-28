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

app.use(express.json({ limit: '10mb' }));
app.use(cors());

// ==========================================
// PROFESSIONAL ROUTING (Clean URLs)
// ==========================================
// 1. Serve static assets (CSS, JS, Images)
app.use(express.static(path.join(__dirname, '../')));

// 2. Redirect any .html request to the clean URL (e.g. /login.html -> /login)
app.use((req, res, next) => {
  if (req.path.endsWith('.html')) {
    const cleanPath = req.path.slice(0, -5);
    return res.redirect(301, cleanPath);
  }
  next();
});

// 3. Handle clean routes by sending the corresponding HTML file
app.use((req, res, next) => {
  // Ignore API routes and files with extensions (like .css, .png)
  if (!req.path.includes('.') && !req.path.startsWith('/api')) {
    const page = req.path === '/' ? 'index' : req.path.substring(1);
    const filePath = path.join(__dirname, '../', `${page}.html`);
    
    return res.sendFile(filePath, (err) => {
      if (err) next(); // If page doesn't exist, move on
    });
  }
  next();
});

// ==========================================
// DATABASE CONNECTION
// ==========================================
const MONGO_URI = process.env.MONGO_URI || "mongodb+srv://sabrinamomotaz404_db_user:Vx23iiVpHeD8Vuh3@campusfindcluster.euliyl8.mongodb.net/campus_lost_found?retryWrites=true&w=majority";
const JWT_SECRET = process.env.JWT_SECRET || "campusfind_super_secret_key_2026_change_me";
const HF_API_TOKEN = process.env.HF_TOKEN || "YOUR_HF_API_TOKEN_HERE"; 

mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch((err) => console.error('❌ MongoDB Connection Error:', err));

const User = require('./models/user');
const Item = require('./models/item');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed!'), false);
  }
});

async function getAIMatchPercentage(item1, item2) {
  if (!item1.description && !item2.description) return item1.category.toLowerCase() === item2.category.toLowerCase() ? 50 : 0;
  try {
    const text1 = `${item1.title}. ${item1.category}. ${item1.color}. ${item1.description}`;
    const text2 = `${item2.title}. ${item2.category}. ${item2.color}. ${item2.description}`;
    const response = await axios.post(
      "https://api-inference.huggingface.co/models/sentence-transformers/all-MiniLM-L6-v2",
      { inputs: { source_sentence: text1, sentences: [text2] } },
      { headers: { "Authorization": `Bearer ${HF_API_TOKEN}`, "Content-Type": "application/json" } }
    );
    const score = response.data[0];
    const percentage = Math.round(score * 100);
    return (item1.category.toLowerCase() === item2.category.toLowerCase() && percentage < 40) ? 50 : percentage;
  } catch (error) {
    let score = 0;
    if (item1.category.toLowerCase() === item2.category.toLowerCase()) score += 40;
    if (item1.color && item2.color && item1.color.toLowerCase() === item2.color.toLowerCase()) score += 20;
    if (item1.building.toLowerCase() === item2.building.toLowerCase()) score += 20;
    return score > 0 ? Math.max(score, 45) : 0;
  }
}

// --- AUTH ---
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, studentId, password } = req.body;
    if (await User.findOne({ studentId })) return res.status(400).json({ message: "Student ID already exists" });
    const salt = await bcrypt.genSalt(10);
    const newUser = new User({ name, studentId, password: await bcrypt.hash(password, salt), role: 'student' });
    await newUser.save();
    res.status(201).json({ message: "User registered successfully" });
  } catch (err) { res.status(500).json({ message: "Failed to register user" }); }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { studentId, password } = req.body;
    const user = await User.findOne({ studentId });
    if (!user || !(await bcrypt.compare(password, user.password))) return res.status(400).json({ message: "Invalid credentials" });
    const token = jwt.sign({ userId: user._id, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, studentId: user.studentId, name: user.name, role: user.role });
  } catch (err) { res.status(500).json({ message: "Server error" }); }
});

// --- ITEMS ---
app.post('/api/items', upload.single('photo'), async (req, res) => {
  try {
    const { type, title, category, color, building, floor, room, date, description, reportedBy } = req.body;
    let aiDescription = null, hasPhoto = false, photo = null, photoType = null;
    if (req.file) {
      hasPhoto = true; photo = req.file.buffer; photoType = req.file.mimetype;
      try {
        const hfResponse = await axios.post(
          'https://api-inference.huggingface.co/models/Salesforce/blip-image-captioning-base',
          req.file.buffer,
          { headers: { 'Authorization': `Bearer ${HF_API_TOKEN}`, 'Content-Type': 'application/octet-stream' } }
        );
        if (hfResponse.data && hfResponse.data[0]) aiDescription = hfResponse.data[0].generated_text;
      } catch (e) {}
    }
    const newItem = new Item({ type, title, category, color, building, floor, room, date, description, reportedBy, aiDescription, hasPhoto, photo, photoType, status: 'open' });
    await newItem.save();
    const matchCount = await Item.countDocuments({ type: type === 'lost' ? 'found' : 'lost', category, status: 'open' });
    res.status(201).json({ message: "Item reported", matchedFound: matchCount, item: newItem });
  } catch (err) { res.status(500).json({ message: "Failed to report item" }); }
});

app.get('/api/items', async (req, res) => {
  try {
    let query = { status: 'open' };
    if (req.query.category) query.category = req.query.category;
    if (req.query.location) query.building = req.query.location;
    if (req.query.date) query.date = req.query.date;
    res.json(await Item.find(query).select('-photo'));
  } catch (err) { res.status(500).json({ message: "Error" }); }
});

app.get('/api/items/my-items/:studentId', async (req, res) => {
  try { res.json(await Item.find({ reportedBy: req.params.studentId }).select('-photo').sort({ createdAt: -1 })); } catch (err) { res.status(500).json({ message: "Error" }); }
});

app.get('/api/items/my-claims/:studentId', async (req, res) => {
  try { res.json(await Item.find({ claimRequestedBy: req.params.studentId }).select('-photo').sort({ createdAt: -1 })); } catch (err) { res.status(500).json({ message: "Error" }); }
});

app.get('/api/items/matches/:studentId', async (req, res) => {
  try {
    const myItems = await Item.find({ reportedBy: req.params.studentId, status: 'open' });
    let matches = [];
    for (const myItem of myItems) {
      const oppositeType = myItem.type === 'lost' ? 'found' : 'lost';
      const potentialMatches = await Item.find({ type: oppositeType, category: myItem.category, reportedBy: { $ne: req.params.studentId }, status: 'open' }).select('-photo');
      for (const otherItem of potentialMatches) {
        const score = await getAIMatchPercentage(myItem, otherItem);
        if (score > 30) {
           matches.push({
            ...otherItem.toObject(), matchPercentage: score, isMatchFor: myItem.title, matchMyId: myItem._id,
            photoItemId: myItem.type === 'found' ? myItem._id : otherItem._id, photoHasPhoto: myItem.type === 'found' ? myItem.hasPhoto : otherItem.hasPhoto,
            matchApproved: myItem.type === 'found' ? myItem.matchApproved : otherItem.matchApproved,
            iAmFoundReporter: myItem.type === 'found', foundItemId: myItem.type === 'found' ? myItem._id : otherItem._id
          });
        }
      }
    }
    matches.sort((a, b) => b.matchPercentage - a.matchPercentage);
    res.json(Array.from(new Map(matches.map(m => [m._id.toString(), m])).values()));
  } catch (err) { res.status(500).json({ message: "Error" }); }
});

app.delete('/api/items/:id', async (req, res) => {
  try {
    const item = await Item.findById(req.params.id);
    if (!item || item.reportedBy !== req.body.studentId) return res.status(403).json({ message: "Unauthorized" });
    await Item.findByIdAndDelete(req.params.id);
    res.json({ message: "Deleted" });
  } catch (err) { res.status(500).json({ message: "Error" }); }
});

// --- CLAIMS ---
app.put('/api/items/:id/confirm-match', async (req, res) => {
  try {
    const item = await Item.findById(req.params.id);
    if (!item || item.type !== 'found' || item.reportedBy !== req.body.studentId) return res.status(403).json({ message: "Unauthorized" });
    item.matchApproved = true;
    await item.save();
    res.json({ message: "Confirmed", item });
  } catch (err) { res.status(500).json({ message: "Error" }); }
});

app.put('/api/items/:id/claim', async (req, res) => {
  try {
    const item = await Item.findById(req.params.id);
    if (!item) return res.status(404).json({ message: "Not found" });
    if (item.type === 'found' && !item.matchApproved) return res.status(403).json({ message: "Finder has not confirmed yet." });
    if (item.reportedBy === req.body.requester) return res.status(400).json({ message: "Cannot claim own item." });
    item.status = 'pending'; item.claimRequestedBy = req.body.requester;
    await item.save();
    res.json({ message: "Requested", item });
  } catch (err) { res.status(500).json({ message: "Error" }); }
});

app.put('/api/items/:id/approve', async (req, res) => {
  try {
    const item = await Item.findById(req.params.id);
    if (!item || item.reportedBy !== req.body.studentId) return res.status(403).json({ message: "Unauthorized" });
    item.status = 'claimed';
    await item.save();
    res.json({ message: "Approved", item });
  } catch (err) { res.status(500).json({ message: "Error" }); }
});

app.put('/api/items/:id/reject', async (req, res) => {
  try {
    const item = await Item.findById(req.params.id);
    if (!item || item.reportedBy !== req.body.studentId) return res.status(403).json({ message: "Unauthorized" });
    item.status = 'open'; item.claimRequestedBy = null;
    await item.save();
    res.json({ message: "Rejected", item });
  } catch (err) { res.status(500).json({ message: "Error" }); }
});

app.get('/api/items/:id/photo', async (req, res) => {
  try {
    const item = await Item.findById(req.params.id).select('+photo +photoType');
    if (!item || !item.hasPhoto) return res.status(404).json({ message: "No photo" });
    const isReporter = item.reportedBy === req.query.requester;
    const isApproved = item.matchApproved && (item.claimRequestedBy === req.query.requester || await Item.findOne({ type: 'lost', reportedBy: req.query.requester, category: item.category }));
    if (!isReporter && !isApproved) return res.status(403).json({ message: "Denied" });
    res.set('Content-Type', item.photoType);
    res.send(item.photo);
  } catch (err) { res.status(500).json({ message: "Error" }); }
});

// --- ADMIN ---
app.get('/api/admin/users', async (req, res) => { try { res.json(await User.find().select('-password')); } catch (err) { res.status(500).json({ message: "Error" }); } });
app.get('/api/admin/items', async (req, res) => { try { res.json(await Item.find().select('-photo').sort({ createdAt: -1 })); } catch (err) { res.status(500).json({ message: "Error" }); } });
app.delete('/api/admin/items/:id', async (req, res) => { try { await Item.findByIdAndDelete(req.params.id); res.json({ message: "Deleted" }); } catch (err) { res.status(500).json({ message: "Error" }); } });

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => { console.log(`🚀 Professional App Running on Port ${PORT}`); });