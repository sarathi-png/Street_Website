const https = require('https');

const DRIVE_TIMEOUT = 60000;

function proxyDriveFile(fileId, apiKey, req, res) {
  if (!apiKey) {
    res.status(502).json({
      error: 'Video unavailable',
      message: 'GOOGLE_DRIVE_API_KEY not configured. Set it in environment variables.'
    });
    return;
  }

  const url = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${apiKey}`);
  const opts = {
    hostname: url.hostname,
    path: url.pathname + url.search,
    method: 'GET',
    timeout: DRIVE_TIMEOUT,
    headers: {
      'User-Agent': 'StreetGallery/1.0'
    }
  };

  const range = req.headers.range;
  if (range) opts.headers['Range'] = range;

  let aborted = false;
  const cleanup = () => { aborted = true; };

  const driveReq = https.request(opts, (driveRes) => {
    if (aborted) return;

    const status = driveRes.statusCode;

    if (status === 200 || status === 206) {
      const resHeaders = {};
      const pass = ['content-range', 'content-length', 'content-type', 'accept-ranges'];
      pass.forEach(h => {
        if (driveRes.headers[h]) resHeaders[h] = driveRes.headers[h];
      });
      resHeaders['Cache-Control'] = 'public, max-age=86400';
      res.writeHead(status, resHeaders);
      driveRes.pipe(res);
      return;
    }

    if (status === 416) {
      const resHeaders = { 'Content-Range': driveRes.headers['content-range'] || `bytes */0` };
      res.writeHead(416, resHeaders);
      driveRes.resume();
      res.end();
      return;
    }

    driveRes.resume();
    let body = '';
    driveRes.on('data', c => body += c);
    driveRes.on('end', () => {
      if (aborted) return;
      if (status === 403) {
        res.status(502).json({
          error: 'Video unavailable',
          message: 'Access denied by Google Drive. Ensure the file is shared as "Anyone with the link".'
        });
      } else if (status === 404) {
        res.status(502).json({
          error: 'Video unavailable',
          message: 'File not found on Google Drive. It may have been deleted.'
        });
      } else if (status === 429) {
        res.status(503).json({
          error: 'Rate limited',
          message: 'Google Drive API rate limit exceeded. Try again later.'
        });
      } else {
        res.status(502).json({
          error: 'Video unavailable',
          message: `Google Drive returned status ${status}. Try again later.`
        });
      }
    });
  });

  driveReq.on('timeout', () => {
    if (aborted) return;
    driveReq.destroy();
    res.status(502).json({
      error: 'Video unavailable',
      message: 'Request to Google Drive timed out. Try again later.'
    });
  });

  driveReq.on('error', (err) => {
    if (aborted) return;
    res.status(502).json({
      error: 'Video unavailable',
      message: 'Failed to connect to Google Drive. Check your network and API key.'
    });
  });

  req.on('close', () => {
    cleanup();
    driveReq.destroy();
  });

  driveReq.end();
}

module.exports = { proxyDriveFile };
