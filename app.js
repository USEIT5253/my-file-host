const form = document.querySelector('#uploadForm');
const fileInput = document.querySelector('#fileInput');
const dropzone = document.querySelector('#dropzone');
const fileTitle = document.querySelector('#fileTitle');
const fileHint = document.querySelector('#fileHint');
const message = document.querySelector('#message');
const button = document.querySelector('#publishBtn');
const slugInput = document.querySelector('#slugInput');
slugInput.addEventListener('input', () => { slugInput.value = slugInput.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60); });

function showFile(file) {
  if (!file) return;
  fileTitle.textContent = file.name;
  fileHint.textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB · Ready to upload`;
}
fileInput.addEventListener('change', () => showFile(fileInput.files[0]));
for (const eventName of ['dragenter', 'dragover']) dropzone.addEventListener(eventName, e => { e.preventDefault(); dropzone.classList.add('dragover'); });
for (const eventName of ['dragleave', 'drop']) dropzone.addEventListener(eventName, e => { e.preventDefault(); dropzone.classList.remove('dragover'); });
dropzone.addEventListener('drop', e => {
  const file = e.dataTransfer.files[0];
  if (file) { const transfer = new DataTransfer(); transfer.items.add(file); fileInput.files = transfer.files; showFile(file); }
});
form.addEventListener('submit', async e => {
  e.preventDefault(); message.className = 'message'; message.textContent = '';
  const file = fileInput.files[0];
  if (!file) { message.className = 'message error'; message.textContent = 'Please choose a PDF or TXT file first.'; return; }
  if (!/\.(pdf|txt)$/i.test(file.name)) { message.className = 'message error'; message.textContent = 'Only PDF and TXT files are allowed.'; return; }
  if (file.size > 25 * 1024 * 1024) { message.className = 'message error'; message.textContent = 'The file must be smaller than 25 MB.'; return; }
  const slug = slugInput.value.trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 60) { message.className = 'message error'; message.textContent = 'Choose a link name using letters, numbers, and hyphens.'; return; }
  const data = new FormData(); data.append('slug', slug); data.append('file', file);
  button.disabled = true; button.innerHTML = 'Uploading… <span>↗</span>';
  try {
    const response = await fetch('/api/upload', { method: 'POST', body: data });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Upload failed.');
    const link = location.origin + result.url;
    message.className = 'message success';
    message.replaceChildren();
    const success = document.createElement('strong'); success.textContent = 'Your link is ready!';
    const br = document.createElement('br');
    const anchor = document.createElement('a'); anchor.href = result.url; anchor.target = '_blank'; anchor.rel = 'noopener'; anchor.textContent = link;
    const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy link'; copy.style.cssText = 'border:0;background:transparent;text-decoration:underline;cursor:pointer;font:inherit;margin-left:8px';
    copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(link); copy.textContent = 'Copied!'; } catch { copy.textContent = link; } });
    message.append(success, br, anchor, copy);
  } catch (err) { message.className = 'message error'; message.textContent = err.message; }
  finally { button.disabled = false; button.innerHTML = 'Upload & generate link <span>→</span>'; }
});
