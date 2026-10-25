# Mini File Host — custom PDF/TXT links

Anonymous PDF and TXT sharing prototype. Users choose a memorable link slug such as `my-notes`; links are served at `/f/my-notes`.

## Run
Requires Node.js 18+.
```bash
npm install
npm start
```
Open http://localhost:3000.

## Notes
- Files are stored locally in `uploaded-files/`.
- Link names must be unique and contain lowercase letters, numbers, and hyphens.
- 25 MB upload limit; PDF signature checked.
- This is a prototype. Before public deployment add rate limiting, malware/content scanning, retention/deletion, robust storage, and appropriate isolation and abuse controls.
