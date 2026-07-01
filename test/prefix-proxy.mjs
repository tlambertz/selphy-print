// Tiny path-prefix proxy: /proxy/8080/* -> localhost:8080/* (mimics IDE preview proxies)
import http from 'node:http';
http.createServer((req, res) => {
  if (!req.url.startsWith('/proxy/8080/')) {
    res.writeHead(404);
    return res.end('not proxied');
  }
  const upstream = http.request(
    {
      host: '127.0.0.1',
      port: 8080,
      path: req.url.slice('/proxy/8080'.length),
      method: req.method,
      headers: { ...req.headers, host: '127.0.0.1:8080' },
    },
    (u) => {
      res.writeHead(u.statusCode, u.headers);
      u.pipe(res);
    }
  );
  req.pipe(upstream);
}).listen(39499, () => console.log('prefix proxy on :39499'));
