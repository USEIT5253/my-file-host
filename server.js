
const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;
const BUCKET = process.env.SUPABASE_BUCKET || 'uploaded-files';

const TTL = 5 * 60 * 60 * 1000; // 5 hours
const MAX = 25 * 1024 * 1024;   // 25 MB
const VIEW_TTL = 10 * 60 * 1000; // 10 minutes

if (
  !process.env.SUPABASE_URL ||
  !process.env.SUPABASE_SERVICE_ROLE_KEY
) {
  console.error('Missing Supabase environment variables');
  process.exit(1);
}

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  }
);

// Temporary viewing sessions are stored in memory.
// They are cleared if the server restarts.
const fileSessions = new Map();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX,
    files: 1
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    if (['.pdf', '.txt'].includes(ext)) {
      return cb(null, true);
    }

    cb(new Error('Only PDF and TXT files are allowed.'));
  }
});

// Serve the website.
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve only approved frontend files.
const frontendFiles = new Set(['style.css', 'app.js']);

app.get('/:asset', (req, res, next) => {
  if (!frontendFiles.has(req.params.asset)) {
    return next();
  }

  res.sendFile(path.join(__dirname, req.params.asset));
});

app.use(express.urlencoded({ extended: false }));

// Validate file-link names.
const valid = s =>
  typeof s === 'string' &&
  s.length <= 60 &&
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);

const cleanName = s =>
  path.basename(String(s || 'file'))
    .replace(/[\r\n\0"]/g, '')
    .slice(0, 180) || 'file';

const metadataPath = slug => `metadata/${slug}.json`;

const hash = (password, salt) =>
  crypto.scryptSync(password, salt, 64).toString('hex');

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;'
  })[c]);
}

// Read metadata from private Supabase Storage.
async function metadata(slug) {
  const { data, error } = await sb.storage
    .from(BUCKET)
    .download(metadataPath(slug));

  if (error || !data) {
    return null;
  }

  try {
    return JSON.parse(await data.text());
  } catch {
    return null;
  }
}

// Remove the uploaded file and its metadata.
async function removeFile(m) {
  if (!m) return;

  const { error } = await sb.storage
    .from(BUCKET)
    .remove([m.objectPath, metadataPath(m.slug)]);

  if (error) {
    console.error('File cleanup error:', error.message);
  }
}

// Delete expired files.
async function cleanup() {
  const { data, error } = await sb.storage
    .from(BUCKET)
    .list('metadata', { limit: 1000 });

  if (error) {
    console.error('Cleanup error:', error.message);
    return;
  }

  for (const item of data || []) {
    if (!item.name.endsWith('.json')) continue;

    const slug = item.name.slice(0, -5);
    const m = await metadata(slug);

    if (m && Date.now() >= m.expiresAt) {
      await removeFile(m);
    }
  }

  // Clear expired temporary viewing sessions.
  for (const [token, session] of fileSessions) {
    if (Date.now() >= session.expiresAt) {
      fileSessions.delete(token);
    }
  }
}

cleanup().catch(err => console.error('Cleanup error:', err));

setInterval(() => {
  cleanup().catch(err => console.error('Cleanup error:', err));
}, 60000).unref();

// Upload a password-protected PDF or TXT file.
app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, async err => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'Maximum file size is 25 MB.'
        : err.message;

      return res.status(400).json({ error: message });
    }

    if (!req.file) {
      return res.status(400).json({
        error: 'Choose a PDF or TXT file.'
      });
    }

    const slug = String(req.body.slug || '')
      .trim()
      .toLowerCase();

    const password = String(req.body.password || '');
    const ext = path.extname(req.file.originalname).toLowerCase();

    if (!valid(slug)) {
      return res.status(400).json({
        error: 'Link name: lowercase letters, numbers and hyphens only.'
      });
    }

    if (password.length < 4 || password.length > 200) {
      return res.status(400).json({
        error: 'Password must be at least 4 characters.'
      });
    }

    if (
      ext === '.pdf' &&
      req.file.buffer.subarray(0, 5).toString() !== '%PDF-'
    ) {
      return res.status(400).json({
        error: 'Invalid PDF file.'
      });
    }

    try {
      await cleanup();

      const old = await metadata(slug);

      if (old && Date.now() < old.expiresAt) {
        return res.status(409).json({
          error: 'Link name already taken.'
        });
      }

      if (old) {
        await removeFile(old);
      }

      const objectPath = `files/${slug}${ext}`;
      const salt = crypto.randomBytes(16).toString('hex');
      const now = Date.now();

      const m = {
        slug,
        objectPath,
        originalName: cleanName(req.file.originalname),
        extension: ext,
        salt,
        passwordHash: hash(password, salt),
        uploadedAt: now,
        expiresAt: now + TTL
      };

      // Upload file to private Supabase Storage.
      const { error: uploadError } = await sb.storage
        .from(BUCKET)
        .upload(objectPath, req.file.buffer, {
          contentType: ext === '.pdf'
            ? 'application/pdf'
            : 'text/plain',
          upsert: false
        });

      if (uploadError) {
        console.error('Supabase file upload error:', uploadError);

        return res.status(500).json({
          error: 'Storage upload failed. Check your Supabase URL, bucket and Render environment variables.'
        });
      }

      // Store metadata and password hash separately.
      const { error: metadataError } = await sb.storage
        .from(BUCKET)
        .upload(
          metadataPath(slug),
          Buffer.from(JSON.stringify(m)),
          {
            contentType: 'application/json',
            upsert: false
          }
        );

      if (metadataError) {
        console.error('Supabase metadata upload error:', metadataError);

        await sb.storage.from(BUCKET).remove([objectPath]);

        return res.status(500).json({
          error: 'Could not save file metadata.'
        });
      }

      const url = `/f/${slug}`;

      res.json({
        name: m.originalName,
        slug,
        url,
        fullUrl: `${req.protocol}://${req.get('host')}${url}`,
        expiresAt: new Date(m.expiresAt).toISOString(),
        expiresInSeconds: TTL / 1000
      });
    } catch (e) {
      console.error('Upload error:', e);

      res.status(500).json({
        error: 'Upload failed.'
      });
    }
  });
});

// Show the password page.
app.get('/f/:id', async (req, res) => {
  const slug = req.params.id;

  if (!valid(slug)) {
    return res.status(404).send('File not found.');
  }

  try {
    const m = await metadata(slug);

    if (!m) {
      return res.status(404).send(
        'File not found or its link has expired.'
      );
    }

    if (Date.now() >= m.expiresAt) {
      await removeFile(m);

      return res.status(410).send(
        'This link has expired. Files are available for 5 hours.'
      );
    }

    res.set('Cache-Control', 'no-store').type('html').send(`
      <!doctype html>
      <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Password required</title>
      </head>
      <body style="font:16px system-ui;background:#f4f6fb;display:grid;place-items:center;min-height:90vh;margin:0;padding:16px;box-sizing:border-box">
        <form method="post" style="background:white;padding:28px;border-radius:14px;max-width:360px;width:100%;box-sizing:border-box">
          <h2>Password-protected file</h2>
          <p>${escapeHtml(m.originalName)}</p>
          <p>Expires: ${new Date(m.expiresAt).toLocaleString()}</p>
          <input name="password" type="password" required autocomplete="current-password" placeholder="Enter password" style="box-sizing:border-box;width:100%;padding:12px">
          <button type="submit" style="width:100%;padding:12px;margin-top:12px">Open file</button>
        </form>
      </body>
      </html>
    `);
  } catch (e) {
    console.error('Password page error:', e);
    res.status(500).send('Could not open file.');
  }
});

// Verify password and display viewing/download options.
app.post('/f/:id', async (req, res) => {
  const slug = req.params.id;

  if (!valid(slug)) {
    return res.status(404).send('File not found.');
  }

  try {
    const m = await metadata(slug);

    if (!m) {
      return res.status(404).send(
        'File not found or its link has expired.'
      );
    }

    if (Date.now() >= m.expiresAt) {
      await removeFile(m);

      return res.status(410).send('This link has expired.');
    }

    const got = Buffer.from(
      hash(String(req.body.password || ''), m.salt),
      'hex'
    );

    const want = Buffer.from(m.passwordHash, 'hex');

    if (
      got.length !== want.length ||
      !crypto.timingSafeEqual(got, want)
    ) {
      return res.status(401).send(`
        <!doctype html>
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <body style="font:16px system-ui;padding:24px">
          <h2>Incorrect password</h2>
          <p>Please go back and try again.</p>
          <a href="/f/${encodeURIComponent(slug)}">Go back</a>
        </body>
      `);
    }

    // Create a random temporary token after password verification.
    const token = crypto.randomBytes(32).toString('hex');

    fileSessions.set(token, {
      slug,
      expiresAt: Math.min(m.expiresAt, Date.now() + VIEW_TTL)
    });

    res.set('Cache-Control', 'no-store').type('html').send(`
      <!doctype html>
      <html lang="en">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Your file</title>
      </head>
      <body style="font:16px system-ui;background:#f4f6fb;padding:24px;text-align:center">
        <main style="background:white;padding:24px;border-radius:14px;max-width:500px;margin:auto">
          <h2>Your file is ready</h2>
          <p>${escapeHtml(m.originalName)}</p>
          <p>Choose how to open your file:</p>
          ${
            m.extension === '.pdf'
              ? `<a href="/view/${token}" target="_blank" rel="noopener" style="display:block;background:#2563eb;color:white;padding:14px;border-radius:8px;text-decoration:none;margin:12px 0">View PDF</a>`
              : `<a href="/view/${token}" style="display:block;background:#2563eb;color:white;padding:14px;border-radius:8px;text-decoration:none;margin:12px 0">View text file</a>`
          }
          <a href="/download/${token}" style="display:block;background:#15803d;color:white;padding:14px;border-radius:8px;text-decoration:none;margin:12px 0">Download file</a>
          <p style="font-size:13px;color:#666">These options expire within 10 minutes or when the file expires.</p>
        </main>
      </body>
      </html>
    `);
  } catch (e) {
    console.error('Password verification error:', e);
    res.status(500).send('Could not open file.');
  }
});

// Deliver the file after password verification.
async function serveProtectedFile(req, res, download) {
  const token = req.params.token;
  const session = fileSessions.get(token);

  if (!session) {
    return res.status(401).send(
      'Viewing link expired. Please enter your password again.'
    );
  }

  if (Date.now() >= session.expiresAt) {
    fileSessions.delete(token);

    return res.status(401).send(
      'Viewing link expired. Please enter your password again.'
    );
  }

  const m = await metadata(session.slug);

  if (!m || Date.now() >= m.expiresAt) {
    fileSessions.delete(token);

    if (m) {
      await removeFile(m);
    }

    return res.status(410).send('This file has expired.');
  }

  const { data, error } = await sb.storage
    .from(BUCKET)
    .download(m.objectPath);

  if (error || !data) {
    console.error('File download error:', error);

    return res.status(404).send('File unavailable.');
  }

  const filename = m.originalName.replace(/["\\\r\n]/g, '_');

  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'no-store');
  res.set(
    'Content-Type',
    m.extension === '.pdf'
      ? 'application/pdf'
      : 'text/plain; charset=utf-8'
  );
  res.set(
    'Content-Disposition',
    `${download ? 'attachment' : 'inline'}; filename="${filename}"`
  );

  res.send(Buffer.from(await data.arrayBuffer()));
}

// Attempt to display the file in the browser.
app.get('/view/:token', (req, res) => {
  serveProtectedFile(req, res, false).catch(err => {
    console.error('View error:', err);

    if (!res.headersSent) {
      res.status(500).send('Could not display file.');
    }
  });
});

// Force a file download.
app.get('/download/:token', (req, res) => {
  serveProtectedFile(req, res, true).catch(err => {
    console.error('Download error:', err);

    if (!res.headersSent) {
      res.status(500).send('Could not download file.');
    }
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Mini File Host listening on ${PORT}`);
});
