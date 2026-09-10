const { Worker } = require('bullmq');
const Redis = require('ioredis');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const connection = new Redis({ host: process.env.REDIS_HOST || '127.0.0.1', port: 6379, maxRetriesPerRequest: null });
const resolutionMap = { '2160p': 2160, '1440p': 1440, '1080p': 1080, '720p': 720, '480p': 480 };

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 1024 * 1024 * 8 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`${command}: ${stderr.slice(-1200) || error.message}`));
      else resolve({ stdout, stderr });
    });
  });
}

async function createBestFrame(inputPath, outputPath) {
  await run('ffmpeg', ['-y', '-i', inputPath, '-vf', 'thumbnail,scale=640:-2', '-frames:v', '1', outputPath]);
}

async function createSubtitles(inputPath, jobId, outputPath) {
  return new Promise(resolve => {
    execFile('which', ['whisper'], async whichError => {
      if (whichError) return resolve(null);
      const dir = path.join('/tmp', `whisper-${jobId}`);
      fs.mkdirSync(dir, { recursive: true });
      try {
        await run('whisper', [inputPath, '--model', process.env.WHISPER_MODEL || 'base', '--output_format', 'srt', '--output_dir', dir]);
        const srt = path.join(dir, `${path.basename(inputPath, path.extname(inputPath))}.srt`);
        if (!fs.existsSync(srt)) return resolve(null);
        const persistentSrt = `${outputPath}.srt`;
        fs.copyFileSync(srt, persistentSrt);
        resolve(persistentSrt);
      } catch (error) {
        console.error(`Whisper failed for ${jobId}:`, error.message);
        resolve(null);
      }
    });
  });
}

function transcode(inputPath, outputPath, options, onProgress) {
  return new Promise((resolve, reject) => {
    const features = options?.features || {};
    const height = resolutionMap[options?.resolution] || 1080;
    const fps = [24, 25, 30, 60, 120].includes(Number(options?.fps)) ? Number(options.fps) : 30;
    const videoFilter = [`scale=-2:${height}`];
    if (features.crop) videoFilter.push('crop=iw*0.96:ih*0.96');
    if (features.rotation) videoFilter.push('rotate=0.008:fillcolor=black@0');
    if (features.denoise) videoFilter.push('hqdn3d=1.2:1.2:6:6');
    if (features.lut && options.lutFile && fs.existsSync(options.lutFile)) {
      videoFilter.push(`lut3d=file='${options.lutFile.replace(/'/g, "\\'")}'`);
    }
    if (features.colorGrading) videoFilter.push('eq=contrast=1.05:saturation=1.08:brightness=0.01');
    if (features.sharpen) videoFilter.push('unsharp=5:5:0.45:5:5:0');
    if (features.vignette) videoFilter.push('vignette=PI/5');
    videoFilter.push('format=yuv420p');

    const audioFilter = [];
    if (features.pitchTempo) audioFilter.push('asetrate=44100*1.02', 'aresample=44100', 'atempo=1.06');
    if (features.audioEQ) audioFilter.push('highpass=f=80', 'lowpass=f=15000');
    if (features.audioCompression) audioFilter.push('acompressor=threshold=-18dB:ratio=2:attack=20:release=250');
    if (features.loudnessNormalization) audioFilter.push('loudnorm=I=-14:TP=-1.5:LRA=11');

    const format = options?.format || 'mp4';
    const args = ['-y', '-i', inputPath, '-map', '0:v:0', '-map', '0:a?', '-vf', videoFilter.join(','), '-r', String(fps)];
    if (audioFilter.length) args.push('-af', audioFilter.join(','));
    if (format === 'webm') args.push('-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', height >= 2160 ? '28' : '32', '-c:a', 'libopus');
    else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', height >= 2160 ? '18' : '21', '-c:a', 'aac');
    if (format === 'mp4' || format === 'mov') args.push('-movflags', '+faststart');
    args.push(outputPath);

    const ffmpeg = spawn('ffmpeg', args);
    let stderr = '';
    ffmpeg.stderr.on('data', chunk => {
      stderr += chunk.toString();
      const matches = stderr.match(/time=\d+:\d+:\d+\.\d+/g);
      if (matches) onProgress(Math.min(95, 10 + matches.length * 2));
      if (stderr.length > 12000) stderr = stderr.slice(-6000);
    });
    ffmpeg.on('error', reject);
    ffmpeg.on('close', code => {
      if (code === 0 && fs.existsSync(outputPath)) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

const worker = new Worker('videoProcessing', async job => {
  const { inputPath, outputPath, thumbnailPath, options = {}, jobId } = job.data;
  const features = options.features || {};
  await job.updateProgress(5);
  await transcode(inputPath, outputPath, options, progress => job.updateProgress(progress));
  await job.updateProgress(96);

  let subtitlePath = null;
  if (features.subtitles || options.subtitles) subtitlePath = await createSubtitles(inputPath, jobId, outputPath);
  if (features.thumbnail !== false && thumbnailPath) {
    try { await createBestFrame(outputPath, thumbnailPath); } catch (error) { console.error('Thumbnail failed:', error.message); }
  }
  await job.updateProgress(100);
  return {
    status: 'completed', jobId, outputPath, thumbnailPath,
    subtitlePath, subtitlesAvailable: Boolean(subtitlePath),
    format: options.format || 'mp4', resolution: options.resolution || '1080p',
    fps: options.fps || 30, features, size: fs.statSync(outputPath).size
  };
}, { connection, concurrency: 1 });

worker.on('completed', job => console.log(`Completed ${job.id}`));
worker.on('failed', (job, error) => console.error(`Failed ${job?.id}:`, error.message));
console.log('BullMQ advanced quality worker listening on videoProcessing');
