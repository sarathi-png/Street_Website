const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

function generateVideoThumb(videoPath, thumbPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-ss', '0.01',
      '-i', videoPath,
      '-vframes', '1',
      '-s', '400x300',
      '-q:v', '2',
      '-loglevel', 'error',
      '-y',
      thumbPath
    ]);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });
    proc.on('error', reject);
  });
}

function probeVideoCodec(filePath) {
  return new Promise((resolve) => {
    const ffprobe = require('fluent-ffmpeg').ffprobe;
    ffprobe(filePath, (err, data) => {
      if (err || !data || !data.streams) { resolve(null); return; }
      const videoStream = data.streams.find(s => s.codec_type === 'video');
      resolve(videoStream ? videoStream.codec_name : null);
    });
  });
}

module.exports = { generateVideoThumb, probeVideoCodec };