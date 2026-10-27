const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const FILES_DIR = path.join(__dirname, 'uploaded-files');
const META_DIR = path.join(__dirname, 'file-metadata');
const TMP_DIR = path.join(__dirname, 'tmp');
const FILE_TTL_MS = 5 * 60 * 60 * 1000; // Files expire 5 hours after upload.
for (const dir of [FILES_DIR, META_DIR, TMP_DIR]) fs.mkdirSync(dir, { recursive: true });
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const allowedExtensions = new Set(['.pdf', '.txt']);
const upload = multer({
  dest: TMP_DIR,
  limits: { fileSize: 25 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!allowedExtensions.has(ext)) return cb(new Error('Only PDF and TXT files are allowed.'));
    cb(null, true);
  }
});

function metadataPath(slug) { return path.join(META_DIR, `${slug}.json`); }
function findFile(slug) {
  for (const ext of allowedExtensions) {
    const candidate = path.join(FILES_DIR, `${slug}${ext}`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
function removeFileAndMetadata(slug, filePath = findFile(slug)) {
  if (filePath) fs.rmSync(filePath, { force: true });
  fs.rmSync(metadataPath(slug), { force: true });
}
function cleanupExpiredFiles() {
  const now = Date.now();
  for (const entry of fs.readdirSync(FILES_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !allowedExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    const filePath = path.join(FILES_DIR, entry.name);
    try {
      const slug = path.basename(entry.name, path.extname(entry.name));
      if (now - fs.statSync(filePath).mtimeMs >= FILE_TTL_MS) removeFileAndMetadata(slug, filePath);
    } catch (_error) { /* Ignore files removed during cleanup. */ }
  }
}
cleanupExpiredFiles();
setInterval(cleanupExpiredFiles, 60 * 1000).unref();

function safeDisplayName(name) {
  return path.basename(String(name || 'file')).replace(/[\r\n\0]/g, '').slice(0, 180) || 'file';
}
function passwordHash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function passwordPage(slug, error = '') {
  const safeSlug = slug.replace(/[^a-z0-9-]/g, '');
  const errorHtml = error ? `<p style="color:#b42318">${error}</p>` : '';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Password required</title><body style="font:16px system-ui;max-width:420px;margin:12vh auto;padding:24px;color:#202124"><h1>This file is password protected</h1><p>Enter the password provided by the person who shared this file.</p>${errorHtml}<form method="post" action="/f/${safeSlug}/unlock"><label for="password">Password</label><br><input id="password" name="password" type="password" required minlength="4" maxlength="200" autocomplete="current-password" style="box-sizing:border-box;width:100%;padding:12px;margin:8px 0 16px"><button style="padding:12px 18px" type="submit">Open file</button></form><p style="color:#666;font-size:13px">Links expire after 5 hours.</p></body></html>`;
}

app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, err => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large. Maximum size is 25 MB.' : err.message;
      return res.status(400).json({ error: message || 'Upload failed.' });
    }
    if (!req.file) return res.status(400).json({ error: 'Choose a PDF or TXT file first.' });
    const ext = path.extname(req.file.originalname).toLowerCase();
    const slug = String(req.body.slug || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 60) {
      fs.rmSync(req.file.path, { force: true });
      return res.status(400).json({ error: 'Use 1–60 characters: lowercase letters, numbers, and hyphens.' });
    }
    if (password.length < 4 || password.length > 200) {
      fs.rmSync(req.file.path, { force: true });
      return res.status(400).json({ error: 'Choose a password between 4 and 200 characters.' });
    }
    cleanupExpiredFiles();
    if (findFile(slug)) {
      fs.rmSync(req.file.path, { force: true });
      return res.status(409).json({ error: 'That link name is already taken. Choose another one.' });
    }
    try {
      if (ext === '.pdf') {
        const fd = fs.openSync(req.file.path, 'r');
        const header = Buffer.alloc(5);
        const bytesRead = fs.readSync(fd, header, 0, 5, 0);
        fs.closeSync(fd);
        if (bytesRead < 5 || header.toString('ascii') !== '%PDF-') {
          fs.rmSync(req.file.path, { force: true });
          return res.status(400).json({ error: 'That file does not look like a valid PDF.' });
        }
      }
      const destination = path.join(FILES_DIR, `${slug}${ext}`);
      fs.renameSync(req.file.path, destination);
      const uploadedAt = new Date();
      fs.utimesSync(destination, uploadedAt, uploadedAt);
      const salt = crypto.randomBytes(16).toString('hex');
      fs.writeFileSync(metadataPath(slug), JSON.stringify({ salt, passwordHash: passwordHash(password, salt), originalName: safeDisplayName(req.file.originalname) }), { mode: 0o600 });
      const url = `/f/${slug}`;
      res.json({ name: safeDisplayName(req.file.originalname), slug, url, fullUrl: `${req.protocol}://${req.get('host')}${url}`, expiresAt: new Date(uploadedAt.getTime() + FILE_TTL_MS).toISOString(), expiresInSeconds: FILE_TTL_MS / 1000 });
    } catch (_error) {
      fs.rmSync(req.file.path, { force: true });
      removeFileAndMetadata(slug);
      res.status(500).json({ error: 'Could not save this file. Please try again.' });
    }
  });
});

app.get('/f/:id', (req, res) => {
  const slug = req.params.id;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 60) return res.status(404).send('File not found');
  const filePath = findFile(slug);
  if (!filePath) return res.status(404).send('File not found or its link has expired.');
  try {
    if (Date.now() - fs.statSync(filePath).mtimeMs >= FILE_TTL_MS) {
      removeFileAndMetadata(slug, filePath);
      return res.status(410).send('This file link has expired. Files are available for 5 hours after upload.');
    }
  } catch (_error) { return res.status(404).send('File not found or its link has expired.'); }
  if (!fs.existsSync(metadataPath(slug))) return res.status(404).send('File protection information not found. Please upload the file again.');
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(passwordPage(slug));
});

app.post('/f/:id/unlock', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
  const slug = req.params.id;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 60) return res.status(404).send('File not found');
  const filePath = findFile(slug);
  if (!filePath) return res.status(404).send('File not found or its link has expired.');
  try {
    if (Date.now() - fs.statSync(filePath).mtimeMs >= FILE_TTL_MS) {
      removeFileAndMetadata(slug, filePath);
      return res.status(410).send('This file link has expired. Files are available for 5 hours after upload.');
    }
    const meta = JSON.parse(fs.readFileSync(metadataPath(slug), 'utf8'));
    const suppliedHash = passwordHash(String(req.body.password || ''), meta.salt);
    const expected = Buffer.from(meta.passwordHash, 'hex');
    const supplied = Buffer.from(suppliedHash, 'hex');
    if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
      return res.status(401).type('html').send(passwordPage(slug, 'Incorrect password. Please try again.'));
    }
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', ext === '.pdf' ? 'application/pdf' : 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="${path.basename(meta.originalName || `${slug}${ext}`).replace(/["\\\r\n]/g, '_')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(filePath);
  } catch (_error) { return res.status(404).send('File not found or its link has expired.'); }
});

app.get('/health', (_req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`Mini File Host running at http://localhost:${PORT}`));
