require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());

// CHANGE 1: Allow multiple files
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

// --- Helpers ---
async function getOrCreateTagIds(tagNamesArray, wpUrl, authHeader) {
  const tagIds = [];
  for (const name of tagNamesArray) {
    const cleanName = name.trim();
    if (!cleanName) continue;
    try {
      const searchRes = await fetch(`${wpUrl}/wp-json/wp/v2/tags?search=${encodeURIComponent(cleanName)}`, { headers: { Authorization: authHeader } });
      const existing = await searchRes.json();
      const match = Array.isArray(existing) ? existing.find(t => t.name.toLowerCase() === cleanName.toLowerCase()) : null;
      if (match) { tagIds.push(match.id); } else {
        const createRes = await fetch(`${wpUrl}/wp-json/wp/v2/tags`, { method: 'POST', headers: { Authorization: authHeader, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: cleanName }) });
        const newTag = await createRes.json();
        if (newTag && newTag.id) tagIds.push(newTag.id);
      }
    } catch (err) { console.warn(`Tag error:`, err.message); }
  }
  return tagIds;
}

async function getOrCreateCategoryId(categoryName, wpUrl, authHeader) {
  const cleanName = categoryName.trim();
  if (!cleanName) return null;
  try {
    const searchRes = await fetch(`${wpUrl}/wp-json/wp/v2/categories?search=${encodeURIComponent(cleanName)}`, { headers: { Authorization: authHeader } });
    const existing = await searchRes.json();
    const match = Array.isArray(existing) ? existing.find(c => c.name.toLowerCase() === cleanName.toLowerCase()) : null;
    if (match) return match.id;
    const createRes = await fetch(`${wpUrl}/wp-json/wp/v2/categories`, { method: 'POST', headers: { Authorization: authHeader, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: cleanName }) });
    const newCat = await createRes.json();
    return newCat && newCat.id ? newCat.id : null;
  } catch (err) { console.warn(`Category error:`, err.message); return null; }
}

// --- FIXED: The proven binary upload logic is now fully included ---
async function uploadMediaToWordPress(file, filename, mimeType, wpUrl, authHeader) {
  const mediaRes = await fetch(`${wpUrl}/wp-json/wp/v2/media`, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Type': mimeType,
      'User-Agent': 'Mmagic-Engine/1.0',
    },
    body: file.buffer,
  });

  if (!mediaRes.ok) {
    const errText = await mediaRes.text();
    console.error(`❌ Media Upload Failed for ${filename}:`, errText);
    return null;
  }
  const json = await mediaRes.json();
  // CRITICAL FIX: Return the full object so we have access to both 'id' and 'source_url'
  return { id: json.id, source_url: json.source_url }; 
}

// --- CHANGE 2: Route accepts multiple files ---
app.post('/mmagic/analyze', upload.array('mm_media', 10), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No media dropped' });
  }

  try {
    const auth = Buffer.from(`${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`).toString('base64');
    const authHeader = `Basic ${auth}`;
    const wpUrl = 'https://mm.world';

    // 1. Analyze the FIRST image for title/story/tags
    const firstFile = req.files[0];
    const imageBase64 = firstFile.buffer.toString('base64');
    const result = await model.generateContent([
      { inlineData: { mimeType: firstFile.mimetype, data: imageBase64 } },
      MMAGIC_PROMPT,
    ]);
    const raw = result.response.text();
    const cleanJson = JSON.parse(raw.replace(/```json|```/g, '').trim());

    // 2. Upload ALL files to WordPress Media Library
    // FIXED: Storing the entire object, not just the ID
    const uploadedMediaObjects = []; 
    for (const file of req.files) {
      const ext = file.mimetype.split('/')[1] || 'bin';
      const filename = `mmagic-${Date.now()}-${Math.random().toString(36).substring(7)}.${ext}`;
      const mediaJson = await uploadMediaToWordPress(file, filename, file.mimetype, wpUrl, authHeader);
      if (mediaJson && mediaJson.id) uploadedMediaObjects.push(mediaJson);
    }

    if (uploadedMediaObjects.length === 0) {
      return res.status(500).json({ error: 'No media could be uploaded to WordPress.' });
    }

    // 3. Build a gallery HTML for the post body (if multiple images)
    let galleryHtml = '';
    if (uploadedMediaObjects.length > 1) {
      galleryHtml = `<div class="mm-gallery" style="display:flex; flex-wrap:wrap; gap:16px; margin-top:24px;">`;
      for (let i = 1; i < uploadedMediaObjects.length; i++) {
        const mediaObj = uploadedMediaObjects[i]; // <--- This is now a proper object!
        // Use mediaObj.source_url for the HTML img src!
        const url = mediaObj.source_url; 
        const id = mediaObj.id;
        
        galleryHtml += `
        <div style="flex:1 1 250px;">
          <img src="${url}" alt="${cleanJson.title}" style="width:100%; height:auto; border-radius:8px;" />
        </div>`;
      }
      galleryHtml += `</div>`;
    }
    
    // 4. Return everything to the frontend (including media IDs and gallery HTML)
    res.json({
      ...cleanJson,
      media_ids: uploadedMediaObjects,      // Array of all WP media objects
      featured_media: uploadedMediaObjects[0].id,
      gallery_html: galleryHtml,   // Pre-built HTML for the post body
    });
  } catch (e) {
    console.error('Analyze/Upload Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// --- Publishing Endpoint ---
app.post('/mmagic/publish', express.json(), async (req, res) => {
  const { title, story, tags, category, media_ids, featured_media, gallery_html, publishNow } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });

  try {
    const auth = Buffer.from(`${process.env.WP_USERNAME}:${process.env.WP_APP_PASSWORD}`).toString('base64');
    const authHeader = `Basic ${auth}`;
    const wpUrl = 'https://mm.world';

    const postData = {
      title,
      content: `<p>${story}</p>${gallery_html || ''}`,
      excerpt: `${story.substring(0, 150)}...`,
      status: publishNow === true ? 'publish' : 'draft',
      featured_media: parseInt(featured_media, 10),
      meta: { _mm_magic_generated: true, _mm_media_ids: Array.isArray(media_ids) ? media_ids.map(m => m.id).join(',') : '' },
    };

    if (tags && tags.trim() !== '') {
      const tagArray = tags.split(',').map(t => t.trim()).filter(t => t.length > 0);
      const tagIds = await getOrCreateTagIds(tagArray, wpUrl, authHeader);
      if (tagIds.length > 0) postData.tags = tagIds;
    }
    if (category && category.trim() !== '') {
      const catId = await getOrCreateCategoryId(category, wpUrl, authHeader);
      if (catId) postData.categories = [catId];
    }

    const postRes = await fetch(`${wpUrl}/wp-json/wp/v2/posts`, {
      method: 'POST',
      headers: { Authorization: authHeader, 'Content-Type': 'application/json', 'User-Agent': 'Mmagic-Engine/1.0' },
      body: JSON.stringify(postData)
    });

    if (!postRes.ok) {
      const errText = await postRes.text();
      console.error(`❌ Post Creation Failed:`, errText);
      throw new Error(`WordPress post creation rejected.`);
    }

    const postJson = await postRes.json();
    console.log(`✅ Post created with featured_media ID: ${featured_media}`);

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
