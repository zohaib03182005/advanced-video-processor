const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs-extra');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const http = require('http');
const socketIo = require('socket.io');
const { Queue } = require('bullmq');
const Redis = require('ioredis');
const { exec } = require('child_process');
const ytdl = require('ytdl-core');
const youtubedl = require('youtube-dl-exec');
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');

// ==================== CONFIG ====================
const PORT = process.env.PORT || 5000;
const UPLOAD_DIR = './uploads';
const PROCESSED_DIR = './processed';
const THUMBNAIL_DIR = './thumbnails';
const MAX_FILE_SIZE = 1024 * 1024 * 1024 * 2; // 2GB
const MAX_CONCURRENT_JOBS = 5;

// ==================== INIT ====================
const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: '*' },
    maxHttpBufferSize: 1e8
});

// Redis connection
const redis = new Redis({ 
    host: process.env.REDIS_HOST || 'localhost', 
    port: 6379 
});

// Queue
const videoQueue = new Queue('videoProcessing', { 
    connection: redis,
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 }
    }
});

// ==================== MIDDLEWARE ====================
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));
app.use(cors());
app.use(express.json({ limit: '2gb' }));
app.use(express.urlencoded({ extended: true, limit: '2gb' }));

// Static files
app.use('/uploads', express.static(UPLOAD_DIR));
app.use('/processed', express.static(PROCESSED_DIR));
app.use('/thumbnails', express.static(THUMBNAIL_DIR));
app.use(express.static(path.join(__dirname, 'dist')));

// Ensure directories
fs.ensureDirSync(UPLOAD_DIR);
fs.ensureDirSync(PROCESSED_DIR);
fs.ensureDirSync(THUMBNAIL_DIR);

// ==================== MULTER CONFIG ====================
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        const base = path.basename(file.originalname, ext);
        cb(null, `${base}_${Date.now()}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: (req, file, cb) => {
        const allowed = ['video/mp4', 'video/mov', 'video/avi', 'video/mkv', 'video/webm', 'video/quicktime'];
        cb(null, allowed.includes(file.mimetype) || file.mimetype.startsWith('video/'));
    }
});

// ==================== SOCKET.IO ====================
io.on('connection', (socket) => {
    console.log('🔌 Client connected:', socket.id);
    
    socket.on('disconnect', () => {
        console.log('❌ Client disconnected:', socket.id);
    });
});

// ==================== HELPERS ====================

// Generate thumbnail from video
async function generateThumbnail(videoPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .screenshots({
                timestamps: ['50%'],
                filename: path.basename(outputPath),
                folder: path.dirname(outputPath),
                size: '640x360'
            })
            .on('end', () => resolve(outputPath))
            .on('error', reject);
    });
}

function mediaOptions(body = {}) {
    const formats = ['mp4', 'mov', 'webm', 'mkv'];
    const resolutions = { '2160p': 2160, '1440p': 1440, '1080p': 1080, '720p': 720, '480p': 480 };
    const fpsValues = [24, 25, 30, 60, 120];
    const builtInLut = path.join(__dirname, 'assets', 'quality.cube');
    const lutFile = process.env.LUT_FILE && fs.existsSync(process.env.LUT_FILE) ? process.env.LUT_FILE : builtInLut;
    let requestedFeatures = body.features || {};
    if (typeof requestedFeatures === 'string') {
        try { requestedFeatures = JSON.parse(requestedFeatures); } catch { requestedFeatures = {}; }
    }
    const enabled = (name, fallback = true) => requestedFeatures && Object.prototype.hasOwnProperty.call(requestedFeatures, name)
        ? requestedFeatures[name] === true || requestedFeatures[name] === 'true'
        : fallback;
    return {
        format: formats.includes(body.outputFormat) ? body.outputFormat : 'mp4',
        resolution: resolutions[body.outputResolution] ? body.outputResolution : '1080p',
        fps: fpsValues.includes(Number(body.outputFps)) ? Number(body.outputFps) : 30,
        lutFile,
        features: {
            crop: enabled('crop'),
            rotation: enabled('rotation'),
            denoise: enabled('denoise'),
            sharpen: enabled('sharpen'),
            colorGrading: enabled('colorGrading'),
            vignette: enabled('vignette'),
            audioEQ: enabled('audioEQ'),
            audioCompression: enabled('audioCompression'),
            loudnessNormalization: enabled('loudnessNormalization'),
            pitchTempo: enabled('pitchTempo', false),
            lut: enabled('lut', false),
            subtitles: enabled('subtitles', false),
            thumbnail: enabled('thumbnail')
        }
    };
}

// Get video metadata
async function getVideoMetadata(videoPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if (err) reject(err);
            else resolve(metadata);
        });
    });
}

// ==================== API ROUTES ====================

// 1. UPLOAD MULTIPLE VIDEOS
app.post('/api/upload', upload.array('videos', 10), async (req, res) => {
    try {
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ error: 'No videos uploaded' });
        }

        const jobs = [];
        
        for (const file of req.files) {
            const jobId = uuidv4();
            const inputPath = file.path;
            const options = mediaOptions(req.body);
            const outputPath = path.join(PROCESSED_DIR, `processed_${jobId}.${options.format}`);
            const thumbnailPath = path.join(THUMBNAIL_DIR, `thumb_${jobId}.jpg`);
            
            // Get metadata
            let metadata = {};
            try {
                metadata = await getVideoMetadata(inputPath);
            } catch (e) {
                console.warn('Metadata fetch failed:', e);
            }
            
            // Generate thumbnail
            if (options.features.thumbnail) {
                try {
                    await generateThumbnail(inputPath, thumbnailPath);
                } catch (e) {
                    console.warn('Thumbnail generation failed:', e);
                }
            }
            
            // Add to queue
            await videoQueue.add('process', {
                jobId,
                inputPath,
                outputPath,
                thumbnailPath,
                originalName: file.originalname,
                metadata,
                socketId: req.body.socketId || null,
                options
            }, { jobId });
            
            jobs.push({
                jobId,
                originalName: file.originalname,
                size: file.size,
                status: 'queued'
            });
        }
        
        res.json({
            success: true,
            jobs,
            message: `${jobs.length} videos queued for processing`
        });
        
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 2. URL SUBMISSION
app.post('/api/url', async (req, res) => {
    try {
        const { url, socketId } = req.body;
        if (!url) return res.status(400).json({ error: 'URL required' });

        const jobId = uuidv4();
        const downloadPath = path.join(UPLOAD_DIR, `download_${jobId}.mp4`);
        const options = mediaOptions(req.body);
        const outputPath = path.join(PROCESSED_DIR, `processed_${jobId}.${options.format}`);
        const thumbnailPath = path.join(THUMBNAIL_DIR, `thumb_${jobId}.jpg`);

        // Download video using yt-dlp
        const downloadCmd = `yt-dlp --no-update --socket-timeout 20 --retries 2 --max-filesize 2G -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best" -o "${downloadPath}" "${url}"`;
        
        exec(downloadCmd, async (error, stdout, stderr) => {
            if (error) {
                console.error('Download error:', stderr);
                return res.status(500).json({ error: 'Failed to download video' });
            }
            
            // Generate thumbnail
            if (options.features.thumbnail) {
                try {
                    await generateThumbnail(downloadPath, thumbnailPath);
                } catch (e) {
                    console.warn('Thumbnail generation failed:', e);
                }
            }
            
            // Queue for processing
            await videoQueue.add('process', {
                jobId,
                inputPath: downloadPath,
                outputPath,
                thumbnailPath,
                originalName: path.basename(url) || 'downloaded_video',
                socketId: socketId || null,
                isUrl: true,
                sourceUrl: url,
                options
            }, { jobId });
            
            res.json({
                success: true,
                jobId,
                message: 'Video downloaded and queued'
            });
        });

    } catch (error) {
        console.error('URL error:', error);
        res.status(500).json({ error: error.message });
    }
});

// 3. GET JOB STATUS
app.get('/api/status/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;
        const job = await videoQueue.getJob(jobId);
        
        if (!job) {
            return res.status(404).json({ error: 'Job not found' });
        }

        const state = await job.getState();
        const progress = job.progress;
        const returnValue = job.returnvalue;

        res.json({
            jobId,
            state,
            progress: progress || 0,
            result: returnValue || null
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 4. GET ALL JOBS (for dashboard)
app.get('/api/jobs', async (req, res) => {
    try {
        const waiting = await videoQueue.getWaiting();
        const active = await videoQueue.getActive();
        const completed = await videoQueue.getCompleted();
        const failed = await videoQueue.getFailed();
        
        const allJobs = [...waiting, ...active, ...completed, ...failed];
        const jobInfos = allJobs.map(job => ({
            id: job.id,
            name: job.name,
            data: job.data,
            state: job.finishedOn ? 'completed' : job.failedReason ? 'failed' : job.progress ? 'active' : 'waiting',
            progress: job.progress || 0,
            timestamp: job.timestamp
        }));
        
        res.json({
            waiting: waiting.length,
            active: active.length,
            completed: completed.length,
            failed: failed.length,
            jobs: jobInfos.slice(-50) // Last 50 jobs
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 5. DOWNLOAD PROCESSED VIDEO
app.get('/api/download/:jobId', async (req, res) => {
    const { jobId } = req.params;
    const job = await videoQueue.getJob(jobId);
    const extension = job?.data?.outputPath ? path.extname(job.data.outputPath) : '.mp4';
    const filePath = path.join(PROCESSED_DIR, `processed_${jobId}${extension}`);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found or not processed yet' });
    }

    res.download(filePath, `processed_${jobId}${extension}`);
});

// 6. DOWNLOAD THUMBNAIL
app.get('/api/thumbnail/:jobId', (req, res) => {
    const { jobId } = req.params;
    const filePath = path.join(THUMBNAIL_DIR, `thumb_${jobId}.jpg`);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Thumbnail not found' });
    }

    res.sendFile(path.resolve(filePath));
});

// 7. DOWNLOAD SUBTITLES
app.get('/api/subtitles/:jobId', async (req, res) => {
    const job = await videoQueue.getJob(req.params.jobId);
    const outputPath = job?.data?.outputPath;
    const filePath = outputPath ? `${outputPath}.srt` : path.join(PROCESSED_DIR, `processed_${req.params.jobId}.mp4.srt`);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Subtitles not available' });
    res.download(filePath, `subtitles_${req.params.jobId}.srt`);
});

// 8. DELETE VIDEO (cleanup)
app.delete('/api/delete/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;
        const job = await videoQueue.getJob(jobId);
        
        const processedPath = path.join(PROCESSED_DIR, `processed_${jobId}.mp4`);
        const alternatePath = job?.data?.outputPath ? path.resolve(job.data.outputPath) : null;
        const uploadPath = path.join(UPLOAD_DIR, `download_${jobId}.mp4`);
        const thumbPath = path.join(THUMBNAIL_DIR, `thumb_${jobId}.jpg`);
        const subtitlePath = alternatePath ? `${alternatePath}.srt` : `${processedPath}.srt`;
        
        // Delete files
        [processedPath, alternatePath, uploadPath, thumbPath, subtitlePath].filter(Boolean).forEach(p => {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        });
        
        // Remove from queue
        if (job) await job.remove();
        
        res.json({ success: true, message: 'Video deleted' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 8. HEALTH CHECK
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        queueSize: {
            waiting: videoQueue.getWaitingCount(),
            active: videoQueue.getActiveCount(),
            completed: videoQueue.getCompletedCount(),
            failed: videoQueue.getFailedCount()
        }
    });
});

// 9. CLEANUP OLD FILES (cron job - run every hour)
app.post('/api/cleanup', async (req, res) => {
    try {
        const now = Date.now();
        const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
        
        let deleted = 0;
        
        // Clean processed files
        const processedFiles = fs.readdirSync(PROCESSED_DIR);
        for (const file of processedFiles) {
            const filePath = path.join(PROCESSED_DIR, file);
            const stats = fs.statSync(filePath);
            if (now - stats.mtimeMs > maxAge) {
                fs.unlinkSync(filePath);
                deleted++;
            }
        }
        
        // Clean uploads
        const uploadFiles = fs.readdirSync(UPLOAD_DIR);
        for (const file of uploadFiles) {
            const filePath = path.join(UPLOAD_DIR, file);
            const stats = fs.statSync(filePath);
            if (now - stats.mtimeMs > maxAge) {
                fs.unlinkSync(filePath);
                deleted++;
            }
        }
        
        res.json({ success: true, deleted });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==================== START SERVER ====================
server.listen(PORT, () => {
    console.log(`🚀 Advanced Server running on http://localhost:${PORT}`);
    console.log(`📊 Queue: ${videoQueue.name}`);
    console.log(`📁 Uploads: ${UPLOAD_DIR}`);
    console.log(`📁 Processed: ${PROCESSED_DIR}`);
});
