require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const FormData = require('form-data');

const app = express();
app.use(cors());
const upload = multer({ storage: multer.memoryStorage() });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-3.5-flash' });

let lastImagePath = null;
let lastImageMime = null;

// Mmagic Proprietary Engine Prompt
const MMAGIC_PROMPT = `You are the Mmagic engine, a proprietary storytelling tool for Miniature Massive. 
Look at this image. Return ONLY valid JSON. Do not put markdown or code blocks. 
Create an engaging human-interest story based on the image. Return this JSON structure:
{
  "title": "A compelling headline (5-10 words)",
  "story": "A beautiful, engaging 3-4 sentence paragraph describing the subject and its significance.",
  "tags": "comma, separated, relevant, keywords, for, searching"
}`;

app.post('/mmagic/analyze', upload.single('mm_media'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No media dropped' });
  try {
    const ext = req.file.mimetype.split('/')[1] || 'jpg';
    const tmpFile = path.join(os.tmpdir(), 'mmagic-' + Date.now() + '.' + ext);
    fs.writeFileSync(tmpFile, req.file.buffer);
    lastImagePath = tmpFile;
    lastImageMime = req.file.mimetype;

    const imageBase64 = req.file.buffer.toString('base64');
    const result = await model.generateContent([
      { inlineData: { mimeType: req.file.mimetype, data: imageBase64 } },
      MMAGIC_PROMPT
    ]);
    const raw = result.response.text();
    const json = JSON.parse(raw.replace(/```json|```/g, '').trim());
    res.json(json);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/mmagic/publish', express.json(), async (req, res) => {
  const { title, story, tags } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required for Mmagic Post' });
  try {
    // 1. Create the WordPress Draft Post
    const postData = {
      title: title,
      content: `<p>${story}</p>`,
      excerpt: story.substring(0, 150) + '...',
      status: 'draft',
      tags: tags ? tags.split(',').map(t => t.trim()) : [],
      meta: { _mm_magic_generated: true }
    };

    // Authenticate with Application Password
    const auth = Buffer.from(
      process.env.WP_USERNAME + ':' + process.env.WP_APP_PASSWORD
    ).toString('base64');

    // Create the Post
    const postResponse = await fetch('https://mm.world/wp-json/wp/v2/posts', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/json',
        'User-Agent': 'Mmagic-Engine/1.0' // <-- Added User Agent
      },
      body: JSON.stringify(postData)
    });

    if (!postResponse.ok) {
      const errText = await postResponse.text();
      throw new Error(`WordPress Post Creation failed: ${errText}`);
    }
    
    const postJson = await postResponse.json();
    const postId = postJson.id;

    // 2. Upload Image to WordPress Media Library
    if (lastImagePath && fs.existsSync(lastImagePath)) {
      try {
        const fileBuffer = fs.readFileSync(lastImagePath);
        const ext = path.extname(lastImagePath).replace('.', '') || 'jpg';
        const filename = 'mmagic-' + Date.now() + '.' + ext;

        const formData = new FormData();
        formData.append('file', fileBuffer, filename);

        // Upload Media
        const mediaResponse = await fetch('https://mm.world/wp-json/wp/v2/media', {
          method: 'POST',
          headers: {
            'Authorization': 'Basic ' + auth,
            'User-Agent': 'Mmagic-Engine/1.0' // <-- Added User Agent here too
          },
          body: formData
        });

        if (mediaResponse.ok) {
          const mediaJson = await mediaResponse.json();
          const mediaId = mediaJson.id;

          // 3. Attach image to the post as the Featured Image
          await fetch(`https://mm.world/wp-json/wp/v2/posts/${postId}`, {
            method: 'POST',
            headers: {
              'Authorization': 'Basic ' + auth,
              'Content-Type': 'application/json',
              'User-Agent': 'Mmagic-Engine/1.0' // <-- Added User Agent here too
            },
            body: JSON.stringify({ featured_media: mediaId })
          });

          console.log('✅ Mmagic Post Created & Image Attached. ID:', postId);
        } else {
          console.log('❌ Media upload failed but post created');
        }

        fs.unlinkSync(lastImagePath);
      } catch (imgErr) {
        console.log('⚠️ Mmagic Image link error:', imgErr.message);
      }
    }

    lastImagePath = null;
    lastImageMime = null;

    res.json({ 
      success: true, 
      post_id: postId, 
      edit_link: `https://mm.world/wp-admin/post.php?post=${postId}&action=edit` 
    });
    
  } catch (e) {
    console.error('Publish Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('Mmagic Engine running on port ' + port));
