const express=require('express');
const multer=require('multer');
const path=require('path');
const crypto=require('crypto');
const {createClient}=require('@supabase/supabase-js');

const app=express(), PORT=process.env.PORT||3000;
const BUCKET=process.env.SUPABASE_BUCKET||'uploaded-files';
const TTL=5*60*60*1000, MAX=25*1024*1024;
if(!process.env.SUPABASE_URL||!process.env.SUPABASE_SERVICE_ROLE_KEY){console.error('Missing Supabase environment variables');process.exit(1)}
const sb=createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:MAX,files:1},fileFilter:(_r,f,cb)=>['.pdf','.txt'].includes(path.extname(f.originalname).toLowerCase())?cb(null,true):cb(new Error('Only PDF and TXT files are allowed.'))});
app.use(express.static(path.join(__dirname,'public')));
app.use(express.urlencoded({extended:false}));
const valid=s=>typeof s==='string'&&s.length<=60&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);
const cleanName=s=>path.basename(String(s||'file')).replace(/[\\r\\n\\0"]/g,'').slice(0,180)||'file';
const mp=s=>`metadata/${s}.json`;
const hash=(p,s)=>crypto.scryptSync(p,s,64).toString('hex');
async function metadata(slug){const {data,error}=await sb.storage.from(BUCKET).download(mp(slug));if(error||!data)return null;try{return JSON.parse(await data.text())}catch{return null}}
async function removeFile(m){if(m)await sb.storage.from(BUCKET).remove([m.objectPath,mp(m.slug)])}
async function cleanup(){const {data,error}=await sb.storage.from(BUCKET).list('metadata',{limit:1000});if(error){console.error('Cleanup:',error.message);return}for(const x of data||[]){if(!x.name.endsWith('.json'))continue;const m=await metadata(x.name.slice(0,-5));if(m&&Date.now()>=m.expiresAt)await removeFile(m)}}
cleanup().catch(console.error);setInterval(()=>cleanup().catch(console.error),60000).unref();

app.post('/api/upload',(req,res)=>upload.single('file')(req,res,async err=>{
 if(err)return res.status(400).json({error:err.code==='LIMIT_FILE_SIZE'?'Maximum file size is 25 MB.':err.message});
 if(!req.file)return res.status(400).json({error:'Choose a PDF or TXT file.'});
 const slug=String(req.body.slug||'').trim().toLowerCase(), password=String(req.body.password||''), ext=path.extname(req.file.originalname).toLowerCase();
 if(!valid(slug))return res.status(400).json({error:'Link name: lowercase letters, numbers and hyphens only.'});
 if(password.length<4||password.length>200)return res.status(400).json({error:'Password must be at least 4 characters.'});
 if(ext==='.pdf'&&req.file.buffer.subarray(0,5).toString()!=='%PDF-')return res.status(400).json({error:'Invalid PDF file.'});
 try{
  await cleanup();const old=await metadata(slug);if(old&&Date.now()<old.expiresAt)return res.status(409).json({error:'Link name already taken.'});if(old)await removeFile(old);
  const objectPath=`files/${slug}${ext}`,salt=crypto.randomBytes(16).toString('hex'),now=Date.now();
  const m={slug,objectPath,originalName:cleanName(req.file.originalname),extension:ext,salt,passwordHash:hash(password,salt),uploadedAt:now,expiresAt:now+TTL};
  const a=await sb.storage.from(BUCKET).upload(objectPath,req.file.buffer,{contentType:ext==='.pdf'?'application/pdf':'text/plain',upsert:false});
  if(a.error){console.error(a.error.message);return res.status(500).json({error:'Storage upload failed. Check that the bucket is private and the environment variables are correct.'})}
  const b=await sb.storage.from(BUCKET).upload(mp(slug),Buffer.from(JSON.stringify(m)),{contentType:'application/json',upsert:false});
  if(b.error){await sb.storage.from(BUCKET).remove([objectPath]);console.error(b.error.message);return res.status(500).json({error:'Could not save file metadata.'})}
  const url=`/f/${slug}`;res.json({name:m.originalName,slug,url,fullUrl:`${req.protocol}://${req.get('host')}${url}`,expiresAt:new Date(m.expiresAt).toISOString(),expiresInSeconds:TTL/1000});
 }catch(e){console.error(e);res.status(500).json({error:'Upload failed.'})}
}));
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
app.get('/f/:id',async(req,res)=>{const slug=req.params.id;if(!valid(slug))return res.status(404).send('File not found.');const m=await metadata(slug);if(!m)return res.status(404).send('File not found or its link has expired.');if(Date.now()>=m.expiresAt){await removeFile(m);return res.status(410).send('This link has expired. Files are available for 5 hours.')}res.set('Cache-Control','no-store').type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Password required</title><body style="font:16px system-ui;background:#f4f6fb;display:grid;place-items:center;min-height:90vh"><form method="post" style="background:white;padding:28px;border-radius:14px;max-width:360px;width:85%"><h2>Password-protected file</h2><p>${esc(m.originalName)}</p><p>Expires: ${new Date(m.expiresAt).toLocaleString()}</p><input name="password" type="password" required placeholder="Enter password" style="box-sizing:border-box;width:100%;padding:12px"><button style="width:100%;padding:12px;margin-top:12px">Open file</button></form></body>`)});
app.post('/f/:id',async(req,res)=>{const slug=req.params.id;if(!valid(slug))return res.status(404).send('File not found.');try{const m=await metadata(slug);if(!m)return res.status(404).send('File not found or its link has expired.');if(Date.now()>=m.expiresAt){await removeFile(m);return res.status(410).send('This link has expired.')}const got=Buffer.from(hash(String(req.body.password||''),m.salt),'hex'),want=Buffer.from(m.passwordHash,'hex');if(got.length!==want.length||!crypto.timingSafeEqual(got,want))return res.status(401).send('Incorrect password. Go back and try again.');const {data,error}=await sb.storage.from(BUCKET).download(m.objectPath);if(error||!data)return res.status(404).send('File unavailable.');res.set('X-Content-Type-Options','nosniff').set('Cache-Control','no-store').set('Content-Type',m.extension==='.pdf'?'application/pdf':'text/plain; charset=utf-8').set('Content-Disposition',`inline; filename="${m.originalName.replace(/["\\\\]/g,'_')}"`);res.send(Buffer.from(await data.arrayBuffer()))}catch(e){console.error(e);res.status(500).send('Could not open file.')}});
app.get('/health',(_req,res)=>res.json({ok:true}));
app.listen(PORT,()=>console.log(`Mini File Host listening on ${PORT}`));
