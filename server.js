const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const FILES_DIR = path.join(__dirname, 'uploaded-files');
const TMP_DIR = path.join(__dirname, 'tmp');
fs.mkdirSync(FILES_DIR, { recursive: true });
fs.mkdirSync(TMP_DIR, { recursive: true });
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

function safeDisplayName(name) {
  return path.basename(String(name || 'file')).replace(/[\r\n\0]/g, '').slice(0, 180) || 'file';
}

app.post('/api/upload', (req, res) => {
  upload.single('file')(req, res, err => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large. Maximum size is 25 MB.' : err.message;
      return res.status(400).json({ error: message || 'Upload failed.' });
    }
    if (!req.file) return res.status(400).json({ error: 'Choose a PDF or TXT file first.' });

    const ext = path.extname(req.file.originalname).toLowerCase();
    // The client sends the chosen slug before the file in the multipart form.
    const slug = String(req.body.slug || '').trim().toLowerCase();
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 60) {
      fs.rmSync(req.file.path, { force: true });
      return res.status(400).json({ error: 'Use 1–60 characters: lowercase letters, numbers, and hyphens.' });
    }
    const destination = path.join(FILES_DIR, `${slug}${ext}`);
    if (['.pdf', '.txt'].some(e => fs.existsSync(path.join(FILES_DIR, `${slug}${e}`)))) {
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
      fs.renameSync(req.file.path, destination);
      const url = `/f/${slug}`;
      res.json({ name: safeDisplayName(req.file.originalname), slug, url, fullUrl: `${req.protocol}://${req.get('host')}${url}` });
    } catch (_error) {
      fs.rmSync(req.file.path, { force: true });
      res.status(500).json({ error: 'Could not save this file. Please try again.' });
    }
  });
});

app.get('/f/:id', (req, res) => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(req.params.id) || req.params.id.length > 60) return res.status(404).send('File not found');
  const candidates = ['.pdf', '.txt'].map(ext => path.join(FILES_DIR, `${req.params.id}${ext}`));
  const filePath = candidates.find(candidate => fs.existsSync(candidate));
  if (!filePath) return res.status(404).send('File not found');
  const ext = path.extname(filePath).toLowerCase();
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', ext === '.pdf' ? 'application/pdf' : 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(filePath);
});

app.get('/health', (_req, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`Mini File Host running at http://localhost:${PORT}`));
