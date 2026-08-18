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
const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

let lastImagePath = null;
let lastImageMime = null;

const MMAGIC_PROMPT = `You are the Mmagic engine, a proprietary storytelling tool for Miniature Massive. Look at this image. Return ONLY valid JSON. Do not put markdown or code blocks. Create an engaging human-interest story based on the image. Return this JSON structure:
{
  "title": "A compelling headline (5-10 words)",
  "story": "A beautiful, engaging 3-4 sentence paragraph describing the subject and its significance.",
  "tags": "comma, separated, relevant, keywords, for, searching",
  "category": "A single relevant category name (e.g. Music & Culture, Design, Architecture)"
}`;

// --- Helper: Tag IDs (Integers) ---
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
      const existingTags = await searchRes.json();
      const match = Array.isArray(existingTags)
        ? existingTags.find(t => t.name.toLowerCase() === cleanName.toLowerCase())
        : null;

      if (match) {
        tagIds.push(match.id);
      } else {
        const createRes = await fetch(`${wpUrl}/wp-json/wp/v2/tags`, {
          method: 'POST',
          headers: {
            Authorization: authHeader,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: cleanName }),
        });
        const newTag = await createRes.json();
        if (newTag && newTag.id) tagIds.push(newTag.id);
      }
    } catch (err) {
      console.warn(`⚠️ Tag resolution error for "${cleanName}":`, err.message);
    }
  }
  return tagIds;
}

// --- Helper: Category ID (Integer) ---
async function getOrCreateCategoryId(categoryName, wpUrl, authHeader) {
  const cleanName = categoryName.trim();
  if (!cleanName) return null;

  try {
    const searchRes = await fetch(
      `${wpUrl}/wp-json/wp/v2/categories?search=${encodeURIComponent(cleanName)}`,
      { headers: { Authorization: authHeader } }
    );
    const existingCats = await searchRes.json();
    const match = Array.isArray(existingCats)
      ? existingCats.find(c => c.name.toLowerCase() === cleanName.toLowerCase())
      : null;

    if (match) return match.id;

    const createRes = await fetch(`${wpUrl}/wp-json/wp/v2/categories`, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: cleanName }),
    });
    const newCat = await createRes.json();
    return newCat && newCat.id ? newCat.id : null;
  } catch (err) {
    console.warn(`⚠️ Category resolution error for "${cleanName}":`, err.message);
    return null;
  }
}

// --- Analysis Endpoint ---
app.post('/mmagic/analyze', upload.single('mm_media'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No media dropped' });
  try {
    const ext = req.file.mimetype.split('/')[1] || 'jpg';
    const tmpFile = path.join(os.tmpdir(), `mmagic-${Date.now()}.${ext}`);
    fs.writeFileSync(tmpFile, req.file.buffer);
    lastImagePath = tmpFile;
    lastImageMime = req.file.mimetype;

    const imageBase64 = req.file.buffer.toString('base64');
    const result = await model.generateContent([
      { inlineData: { mimeType: req.file.mimetype, data: imageBase64 } },
      MMAGIC_PROMPT,
    ]);

    const raw = result.response.text();
    const cleanJson = JSON.parse(raw.replace(/```json|```/g, '').trim());
    res.json(cleanJson);
  } catch (e) {
    console.error('Analysis error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// --- Publishing Endpoint ---
app.post('/mmagic/publish', express.json(), async (req, res) => {
  const { title, story, tags, category, publishNow } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required for Mmagic Post' });

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

    // 1. Resolve Tag IDs
    if (tags && tags.trim() !== '') {
      const tagNameArray = tags.split(',').map(t => t.trim()).filter(t => t.length > 0);
      const tagIds = await getOrCreateTagIds(tagNameArray, wpUrl, authHeader);
      if (tagIds.length > 0) postData.tags = tagIds;
    }

    // 2. Resolve Category ID
    if (category && category.trim() !== '') {
      const catId = await getOrCreateCategoryId(category, wpUrl, authHeader);
      if (catId) {
        postData.categories = [catId];
        console.log(`✅ Assigned category "${category}" with ID: ${catId}`);
      }
    }

    // 3. Create the Post
    const postResponse = await fetch(`${wpUrl}/wp-json/wp/v2/posts`, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
        'User-Agent': 'Mmagic-Engine/1.0',
      },
      body: JSON.stringify(postData),
    });

    if (!postResponse.ok) {
      const errText = await postResponse.text();
      console.error(`❌ Post creation failed (${postResponse.status}):`, errText);
      throw new Error(`WordPress rejected post (${postResponse.status}). Check Render logs.`);
    }

    const postJson = await postResponse.json();
    const postId = postJson.id;

    // 4. Upload Image & Attach Featured Media
    let mediaId = null;
    if (lastImagePath && fs.existsSync(lastImagePath)) {
      try {
        const fileBuffer = fs.readFileSync(lastImagePath);
        const filename = path.basename(lastImagePath);
        const formData = new FormData();
        formData.append('file', fileBuffer, {
          filename,
          contentType: lastImageMime || 'image/jpeg',
        });

        const mediaResponse = await fetch(`${wpUrl}/wp-json/wp/v2/media`, {
          method: 'POST',
          headers: {
            ...formData.getHeaders(),
            Authorization: authHeader,
            'User-Agent': 'Mmagic-Engine/1.0',
          },
          body: formData,
        });

        if (mediaResponse.ok) {
          const mediaJson = await mediaResponse.json();
          mediaId = mediaJson.id;
          console.log(`✅ Media uploaded successfully (ID: ${mediaId})`);

          const attachRes = await fetch(`${wpUrl}/wp-json/wp/v2/posts/${postId}`, {
            method: 'POST',
            headers: {
              Authorization: authHeader,
              'Content-Type': 'application/json',
              'User-Agent': 'Mmagic-Engine/1.0',
            },
            body: JSON.stringify({ featured_media: mediaId }),
          });

          if (attachRes.ok) {
            console.log(`✅ Attached featured image ID ${mediaId} to Post ${postId}`);
          } else {
            const attachErr = await attachRes.text();
            console.warn(`⚠️ Post created, but attaching featured media failed:`, attachErr);
          }
        } else {
          const mediaErrText = await mediaResponse.text();
          console.warn(`⚠️ Post created, but image upload failed (${mediaResponse.status}):`, mediaErrText);
        }

        fs.unlinkSync(lastImagePath);
      } catch (imgErr) {
        console.warn('⚠️ Image processing exception:', imgErr.message);
      }
    }

    lastImagePath = null;
    lastImageMime = null;

    res.json({
      success: true,
      post_id: postId,
      edit_link: `https://mm.world/wp-admin/post.php?post=${postId}&action=edit`,
    });
  } catch (e) {
    console.error('Publish Route Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Mmagic Engine active on port ${port}`));
