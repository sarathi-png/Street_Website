const path = require('path');

const resolvePath = (envVar, defaultSubdir) => {
  if (process.env[envVar]) return process.env[envVar];
  if (process.env.RAILWAY_VOLUME_MOUNT_PATH)
    return path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, defaultSubdir);
  return path.join(__dirname, defaultSubdir);
};

module.exports = {
  PORT: process.env.PORT || 3000,
  UPLOADS_DIR: resolvePath('UPLOADS_DIR', 'uploads'),
  THUMBS_DIR: resolvePath('THUMBNAILS_DIR', 'thumbnails'),
  DATA_FILE: process.env.DATA_FILE
    || (process.env.RAILWAY_VOLUME_MOUNT_PATH
      ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'data.db')
      : path.join(__dirname, 'data.db')),
  GOOGLE_DRIVE_API_KEY: process.env.GOOGLE_DRIVE_API_KEY || '',
  SESSION_SECRET: process.env.SESSION_SECRET || 'dev-secret',
  UPLOAD_MAX_SIZE: (parseInt(process.env.UPLOAD_MAX_SIZE) || 100) * 1024 * 1024,
  PAGE_SIZE: 24,
  ALLOWED_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
    'audio/mpeg', 'audio/mp3', 'audio/flac', 'audio/wav', 'audio/ogg',
    'audio/aac', 'audio/wma', 'audio/x-m4a', 'audio/mp4'],
};
