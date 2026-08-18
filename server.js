require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
const upload = multer({ storage: multer.memoryStorage() });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

const MMAGIC_PROMPT = `You are the Mmagic engine, a proprietary storytelling tool for Miniature Massive. Look at this image. Return ONLY valid JSON. Do not put markdown or code blocks. Create an engaging human-interest story based on the image. Return this JSON structure:
{
  "title": "A compelling headline (5-10 words)",
  "story": "A beautiful, engaging 3-4 sentence paragraph describing the subject and its significance.",
  "tags": "comma, separated, relevant, keywords, for, searching",
  "category": "A single relevant category name (e.g. Music & Culture, Design, Architecture)"
}`;

// --- Helper: Tag IDs ---
async function getOrCreateTagIds(tagNamesArray, wpUrl, authHeader) {
  const tagIds = [];
  for (const name of tagNamesArray) {
    const cleanName = name.trim();
    if (!cleanName) continue;
    try {
      const searchRes = await fetch(
        `${wpUrl}/wp-json/wp/v2/tags?search=${encodeURIComponent(cleanName)}`,
        { headers: { Authorization: authHeader } }
      );
      const existing = await searchRes.json();
      const match = Array.isArray(existing)
        ? existing.find(t => t.name.toLowerCase() === cleanName.toLowerCase())
        : null;

      if (match) {
        tagIds.push(match.id);
      } else {
        const createRes = await fetch(`${wpUrl}/wp-json/wp/v2/tags`, {
          method: 'POST',
          headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: cleanName }),
        });
        const newTag = await createRes.json();
        if (newTag && newTag.id) tagIds.push(newTag.id);
      }
    } catch (err) {
      console.warn(`Tag error (${cleanName}):`, err.message);
    }
  }
  return tagIds;
}

// --- Helper: Category ID ---
async function getOrCreateCategoryId(categoryName, wpUrl, authHeader) {
  const cleanName = categoryName.trim();
  if (!cleanName) return null;
  try {
    const searchRes = await fetch(
      `${wpUrl}/wp-json/wp/v2/categories?search=${encodeURIComponent(cleanName)}`,
      { headers: { Authorization: authHeader } }
    );
    const existing = await searchRes.json();
    const match = Array.isArray(existing)
      ? existing.find(c => c.name.toLowerCase() === cleanName.toLowerCase())
      : null;

    if (match) return match.id;

    const createRes = await fetch(`${wpUrl}/wp-json/wp/v2/categories`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: cleanName }),
    });
    const newCat = await createRes.json();
    return newCat && newCat.id ? newCat.id : null;
  } catch (err) {
    console.warn(`Category error (${cleanName}):`, err.message);
    return null;
  }
}

// --- 1. ANALYZE & UPLOAD MEDIA SIMULTANEOUSLY ---
app.post('/mmagic/analyze', upload.single('mm_media'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No media uploaded' });

  try {
    const auth = Buffer.from(
      `${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`
    ).toString('base64');
    const authHeader = `Basic ${auth}`;
    const wpUrl = 'https://mm.world';

    // A. Generate AI story
    const imageBase64 = req.file.buffer.toString('base64');
    const result = await model.generateContent([
      { inlineData: { mimeType: req.file.mimetype, data: imageBase64 } },
      MMAGIC_PROMPT,
    ]);
    const raw = result.response.text();
    const cleanJson = JSON.parse(raw.replace(/```json|```/g, '').trim());

    // B. Direct binary upload to WordPress (bypasses FormData bugs)
    const ext = req.file.mimetype.split('/')[1] || 'jpg';
    const filename = `mmagic-${Date.now()}.${ext}`;

    const mediaRes = await fetch(`${wpUrl}/wp-json/wp/v2/media`, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Type': req.file.mimetype,
        'User-Agent': 'Mmagic-Engine/1.0',
      },
      body: req.file.buffer,
    });

    if (!mediaRes.ok) {
      const errText = await mediaRes.text();
      console.error(`❌ WordPress Media Upload Rejected (${mediaRes.status}):`, errText);
      return res.status(mediaRes.status).json({
        error: `WordPress media upload failed (${mediaRes.status}). Check file permissions/size.`,
      });
    }

    const mediaJson = await mediaRes.json();
    console.log(`✅ Image uploaded to WP Media Library. ID: ${mediaJson.id}`);

    // Return the story data AND the verified WP media ID
    res.json({
      ...cleanJson,
      media_id: mediaJson.id,
    });
  } catch (e) {
    console.error('Analyze/Upload Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// --- 2. PUBLISH POST WITH ATTACHED MEDIA ---
app.post('/mmagic/publish', express.json(), async (req, res) => {
  const { title, story, tags, category, media_id, publishNow } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  try {
    const auth = Buffer.from(
      `${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`
    ).toString('base64');
    const authHeader = `Basic ${auth}`;
    const wpUrl = 'https://mm.world';

    const postData = {
      title,
      content: `<p>${story}</p>`,
      excerpt: `${story.substring(0, 150)}...`,
      status: publishNow === true ? 'publish' : 'draft',
      meta: { _mm_magic_generated: true },
    };

    // Attach Featured Image ID
    if (media_id) {
      postData.featured_media = parseInt(media_id, 10);
    }

    // Resolve Tags
    if (tags && tags.trim() !== '') {
      const tagArray = tags.split(',').map(t => t.trim()).filter(t => t.length > 0);
      const tagIds = await getOrCreateTagIds(tagArray, wpUrl, authHeader);
      if (tagIds.length > 0) postData.tags = tagIds;
    }

    // Resolve Category
    if (category && category.trim() !== '') {
      const catId = await getOrCreateCategoryId(category, wpUrl, authHeader);
      if (catId) postData.categories = [catId];
    }

    // Create post in WordPress
    const postRes = await fetch(`${wpUrl}/wp-json/wp/v2/posts`, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
        'User-Agent': 'Mmagic-Engine/1.0',
      },
      body: JSON.stringify(postData),
    });

    if (!postRes.ok) {
      const errText = await postRes.text();
      console.error(`❌ Post Creation Failed (${postRes.status}):`, errText);
      throw new Error(`WordPress post creation rejected (${postRes.status}).`);
    }

    const postJson = await postRes.json();
    console.log(`✅ Post created with featured_media ID: ${postData.featured_media}`);

    res.json({
      success: true,
      post_id: postJson.id,
      edit_link: `https://mm.world/wp-admin/post.php?post=${postJson.id}&action=edit`,
    });
  } catch (e) {
    console.error('Publish Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Mmagic Engine active on port ${port}`));
