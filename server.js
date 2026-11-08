const http=require('http');
const fs=require('fs');
const path=require('path');
const root=__dirname;
const port=process.env.PORT||8080;
http.createServer((req,res)=>{
  let pathname;
  try{pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname)}catch(e){res.writeHead(400);return res.end('Bad request')}
  let relative=pathname==='/'?'index.html':pathname;
  while(relative.startsWith('/')) relative=relative.slice(1);
  const file=path.resolve(root,relative);
  if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403);return res.end('Forbidden')}
  fs.readFile(file,(err,data)=>{
    if(err){res.writeHead(err.code==='ENOENT'?404:500,{'Content-Type':'text/plain; charset=utf-8'});return res.end(err.code==='ENOENT'?'Not found':'Server error')}
    const ext=path.extname(file);
    const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.webp':'image/webp'};
    res.writeHead(200,{'Content-Type':types[ext]||'application/octet-stream','Cache-Control':'no-store'});
    res.end(data);
  });
}).listen(port,'0.0.0.0',()=>console.log('WC Wallet listening on '+port));