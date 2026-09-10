import React, { useState, useRef, useEffect } from 'react';
import { io } from 'socket.io-client';
import axios from 'axios';
import {
  Upload, Link, Loader2, CheckCircle, Download, XCircle, 
  Moon, Sun, Trash2, GripVertical, Play, Eye, EyeOff,
  Grid, List, Film, Music, Image, Scissors, Maximize2,
  Minimize2, Copy, Check, Clock, HardDrive, Zap
} from 'lucide-react';
const API_URL = window.location.origin;
const SOCKET_URL = window.location.origin;

// ==================== MAIN APP ====================
function App() {
  // State
  const [files, setFiles] = useState([]);
  const [url, setUrl] = useState('');
  const [jobs, setJobs] = useState([]);
  const [darkMode, setDarkMode] = useState(true);
  const [isProcessing, setIsProcessing] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [outputFormat, setOutputFormat] = useState('mp4');
  const [outputResolution, setOutputResolution] = useState('1080p');
  const [outputFps, setOutputFps] = useState('30');
  const [autoSubtitles, setAutoSubtitles] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [advancedFeatures, setAdvancedFeatures] = useState({
    crop: true, rotation: true, denoise: true, sharpen: true, colorGrading: true,
    vignette: true, audioEQ: true, audioCompression: true, loudnessNormalization: true,
    pitchTempo: false, lut: false, subtitles: false, thumbnail: true
  });
  const [progress, setProgress] = useState({});
  const [viewMode, setViewMode] = useState('grid'); // grid | list
  const [selectedJob, setSelectedJob] = useState(null);
  const [showComparison, setShowComparison] = useState(false);
  
  const fileInputRef = useRef(null);
  const socketRef = useRef(null);
  const dropRef = useRef(null);

  // Connect to socket
  useEffect(() => {
    socketRef.current = io(SOCKET_URL);
    
    socketRef.current.on('progress', (data) => {
      setProgress(prev => ({ ...prev, [data.jobId]: data.progress }));
    });

    socketRef.current.on('complete', (data) => {
      setJobs(prev => prev.map(job => 
        job.jobId === data.jobId 
          ? { ...job, status: 'completed', progress: 100, result: data }
          : job
      ));
      setIsProcessing(false);
    });

    socketRef.current.on('error', (data) => {
      setJobs(prev => prev.map(job => 
        job.jobId === data.jobId 
          ? { ...job, status: 'failed', error: data.message }
          : job
      ));
      setIsProcessing(false);
    });

    return () => socketRef.current.disconnect();
  }, []);

  useEffect(() => {
    const trackedJobs = jobs.filter(job => ['queued', 'downloading', 'processing'].includes(job.status));
    if (trackedJobs.length === 0) return undefined;

    const refreshStatuses = async () => {
      await Promise.all(trackedJobs.map(async job => {
        try {
          const response = await axios.get(`${API_URL}/api/status/${job.jobId}`);
          const state = response.data.state;
          setJobs(prev => prev.map(item => item.jobId === job.jobId ? {
            ...item,
            status: state === 'completed' ? 'completed' : state === 'failed' ? 'failed' : state === 'active' ? 'processing' : 'queued',
            progress: response.data.progress || item.progress || 0,
            result: response.data.result || item.result,
            error: state === 'failed' ? 'Video processing failed' : item.error
          } : item));
        } catch (error) {
          if (error.response?.status !== 404) console.error('Status check error:', error);
        }
      }));
    };

    refreshStatuses();
    const timer = setInterval(refreshStatuses, 2000);
    return () => clearInterval(timer);
  }, [jobs]);

  // ==================== HANDLERS ====================

  const handleDrop = (e) => {
    e.preventDefault();
    const droppedFiles = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('video/'));
    if (droppedFiles.length > 0) {
      handleFiles(droppedFiles);
    }
  };

  const handleFileSelect = (e) => {
    const selectedFiles = Array.from(e.target.files).filter(f => f.type.startsWith('video/'));
    if (selectedFiles.length > 0) {
      handleFiles(selectedFiles);
    }
    e.target.value = '';
  };

  const handleFiles = async (selectedFiles) => {
    setIsProcessing(true);
    setErrorMessage('');
    
    const formData = new FormData();
    selectedFiles.forEach(file => {
      formData.append('videos', file);
    });
    formData.append('socketId', socketRef.current.id);
    formData.append('outputFormat', outputFormat);
    formData.append('outputResolution', outputResolution);
    formData.append('outputFps', outputFps);
    formData.append('features', JSON.stringify(advancedFeatures));

    try {
      const res = await axios.post(`${API_URL}/api/upload`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (progressEvent) => {
          const pct = Math.round((progressEvent.loaded * 100) / progressEvent.total);
          // Update progress for all jobs roughly
        }
      });

      const newJobs = res.data.jobs.map(job => ({
        ...job,
        status: 'queued',
        progress: 0,
        preview: URL.createObjectURL(selectedFiles.find(f => f.name === job.originalName))
      }));

      setJobs(prev => [...newJobs, ...prev]);
      setFiles(prev => [...prev, ...selectedFiles]);
      setIsProcessing(false);

    } catch (error) {
      console.error('Upload error:', error);
      setErrorMessage(error.response?.data?.error || 'Upload failed. Please try again.');
      setIsProcessing(false);
    }
  };

  const handleUrlSubmit = async () => {
    if (!url) return;
    setIsProcessing(true);
    setErrorMessage('');

    try {
      const res = await axios.post(`${API_URL}/api/url`, {
        url,
        socketId: socketRef.current.id,
        outputFormat,
        outputResolution,
        outputFps,
        features: advancedFeatures
      });

      const newJob = {
        jobId: res.data.jobId,
        originalName: 'URL Video',
        status: 'downloading',
        progress: 10,
        sourceUrl: url
      };

      setJobs(prev => [newJob, ...prev]);
      setIsProcessing(false);

    } catch (error) {
      console.error('URL error:', error);
      setErrorMessage(error.response?.data?.error || 'Unable to process this video URL.');
      setIsProcessing(false);
    }
  };

  const removeJob = async (jobId) => {
    try {
      await axios.delete(`${API_URL}/api/delete/${jobId}`);
      setJobs(prev => prev.filter(j => j.jobId !== jobId));
    } catch (error) {
      console.error('Delete error:', error);
      setErrorMessage(error.response?.data?.error || 'Unable to delete this video.');
    }
  };

  const clearAll = () => {
    if (window.confirm('Delete all processed videos?')) {
      jobs.forEach(job => {
        if (job.status === 'completed') {
          axios.delete(`${API_URL}/api/delete/${job.jobId}`);
        }
      });
      setJobs([]);
      setFiles([]);
    }
  };

  // ==================== RENDER ====================

  const JobCard = ({ job }) => {
    const isComplete = job.status === 'completed';
    const isFailed = job.status === 'failed';
    const isProcessing = ['queued', 'downloading', 'processing'].includes(job.status);
    const progressValue = progress[job.jobId] || job.progress || 0;

    return (
      <div className={`bg-gray-800 rounded-xl overflow-hidden border border-gray-700 hover:border-blue-500 transition-all duration-300 ${viewMode === 'grid' ? 'w-full' : 'flex items-center gap-4 p-4'}`}>
        {/* Thumbnail */}
        <div className={`${viewMode === 'grid' ? 'w-full aspect-video bg-gray-900 relative' : 'w-40 aspect-video bg-gray-900 rounded-lg flex-shrink-0'}`}>
          {job.preview ? (
            <video src={job.preview} className="w-full h-full object-cover" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-gray-600">
              <Film size={40} />
            </div>
          )}
          
          {/* Status badge */}
          <div className="absolute top-2 right-2 px-2 py-1 rounded-full text-xs font-medium">
            {isComplete && <span className="bg-green-500/20 text-green-400 px-2 py-1 rounded-full">✅ Done</span>}
            {isFailed && <span className="bg-red-500/20 text-red-400 px-2 py-1 rounded-full">❌ Failed</span>}
            {isProcessing && <span className="bg-blue-500/20 text-blue-400 px-2 py-1 rounded-full animate-pulse">⏳ {job.status}</span>}
          </div>
        </div>

        {/* Info */}
        <div className={`${viewMode === 'grid' ? 'p-4' : 'flex-1 p-4'}`}>
          <div className="flex items-start justify-between">
            <div>
              <h3 className="font-medium text-white truncate max-w-[200px]">{job.originalName || 'Untitled'}</h3>
              <p className="text-sm text-gray-400">
                {job.size ? `${(job.size / 1024 / 1024).toFixed(2)} MB` : ''}
                {job.sourceUrl && ` • ${job.sourceUrl.substring(0, 30)}...`}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {isComplete && (
                <a
                  href={`${API_URL}/api/download/${job.jobId}`}
                  download
                  className="bg-green-600 hover:bg-green-700 p-2 rounded-lg transition"
                >
                  <Download size={16} />
                </a>
              )}
              {isComplete && job.result?.subtitlesAvailable && (
                <a
                  href={`${API_URL}/api/subtitles/${job.jobId}`}
                  download
                  className="bg-purple-600 hover:bg-purple-700 p-2 rounded-lg transition"
                  title="Download subtitles"
                >
                  <span className="text-xs font-bold">SRT</span>
                </a>
              )}
              <button
                onClick={() => removeJob(job.jobId)}
                className="bg-red-600/20 hover:bg-red-600/40 p-2 rounded-lg transition text-red-400"
              >
                <Trash2 size={16} />
              </button>
            </div>
          </div>

          {/* Progress */}
          {isProcessing && (
            <div className="mt-2">
              <div className="w-full bg-gray-700 rounded-full h-2 overflow-hidden">
                <div 
                  className="h-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all duration-300"
                  style={{ width: `${progressValue}%` }}
                />
              </div>
              <p className="text-right text-xs text-gray-500 mt-1">{progressValue}%</p>
            </div>
          )}

          {isFailed && (
            <p className="text-sm text-red-400 mt-1">{job.error || 'Processing failed'}</p>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className={`min-h-screen ${darkMode ? 'bg-gray-900 text-white' : 'bg-gray-50 text-gray-900'} transition-all duration-300`}>
      <div className="max-w-7xl mx-auto p-4 md:p-6">
        
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl md:text-4xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
              🎬 Video Fingerprint Killer
            </h1>
            <p className="text-gray-400 text-sm mt-1">
              Upload or paste URL — 100% copyright-free, no quality loss
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}
              className={`p-2 rounded-lg ${darkMode ? 'bg-gray-800' : 'bg-white shadow'} transition`}
            >
              {viewMode === 'grid' ? <List size={20} /> : <Grid size={20} />}
            </button>
            <button
              onClick={() => setDarkMode(!darkMode)}
              className={`p-2 rounded-lg ${darkMode ? 'bg-gray-800' : 'bg-white shadow'} transition`}
            >
              {darkMode ? <Sun size={20} /> : <Moon size={20} />}
            </button>
            {jobs.length > 0 && (
              <button
                onClick={clearAll}
                className="p-2 rounded-lg bg-red-600/20 text-red-400 hover:bg-red-600/40 transition"
              >
                <Trash2 size={20} />
              </button>
            )}
          </div>
        </div>

        {/* Input Section */}
        <div className="grid md:grid-cols-2 gap-6 mb-8">
          {/* Drop Zone */}
          <div
            ref={dropRef}
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            className={`border-2 border-dashed rounded-2xl p-8 text-center transition cursor-pointer
              ${darkMode ? 'border-gray-700 hover:border-blue-500' : 'border-gray-300 hover:border-blue-500'}
              ${isProcessing ? 'opacity-50 pointer-events-none' : ''}
            `}
            onClick={() => fileInputRef.current.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="video/*"
              multiple
              onChange={handleFileSelect}
              className="hidden"
              disabled={isProcessing}
            />
            <Upload size={48} className={`mx-auto mb-3 ${darkMode ? 'text-gray-500' : 'text-gray-400'}`} />
            <p className="font-medium">Drop videos here or click to browse</p>
            <p className={`text-sm mt-1 ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
              MP4, MOV, AVI, MKV, WEBM • Up to 2GB each • Max 10 at a time
            </p>
          </div>

          {/* URL Input */}
          <div className={`rounded-2xl p-6 border ${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'} transition`}>
            <h3 className="font-medium mb-3 flex items-center gap-2">
              <Link size={20} /> Paste Video URL
            </h3>
            <div className="flex gap-2">
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="YouTube, TikTok, Instagram, or direct link..."
                className={`flex-1 px-4 py-2 rounded-lg outline-none transition
                  ${darkMode ? 'bg-gray-700 text-white focus:ring-2 focus:ring-blue-500' : 'bg-gray-100 text-gray-900 focus:ring-2 focus:ring-blue-500'}
                `}
                disabled={isProcessing}
              />
              <button
                onClick={handleUrlSubmit}
                disabled={!url || isProcessing}
                className="bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white px-4 py-2 rounded-lg transition font-medium"
              >
                Process
              </button>
            </div>
            <p className={`text-xs mt-2 ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
              Supports most video hosting platforms
            </p>
            <div className="mt-4 grid grid-cols-3 gap-2 text-xs">
              <select value={outputFormat} onChange={e => setOutputFormat(e.target.value)} className="rounded-lg bg-gray-700 px-2 py-2 text-white" disabled={isProcessing}>
                <option value="mp4">MP4</option><option value="mov">MOV</option><option value="webm">WebM</option><option value="mkv">MKV</option>
              </select>
              <select value={outputResolution} onChange={e => setOutputResolution(e.target.value)} className="rounded-lg bg-gray-700 px-2 py-2 text-white" disabled={isProcessing}>
                <option value="2160p">4K</option><option value="1440p">1440p</option><option value="1080p">1080p</option><option value="720p">720p</option><option value="480p">480p</option>
              </select>
              <select value={outputFps} onChange={e => setOutputFps(e.target.value)} className="rounded-lg bg-gray-700 px-2 py-2 text-white" disabled={isProcessing}>
                <option value="24">24 FPS</option><option value="30">30 FPS</option><option value="60">60 FPS</option><option value="120">120 FPS</option>
              </select>
            </div>
            <button type="button" onClick={() => setShowAdvanced(!showAdvanced)} className="mt-3 text-xs text-blue-300 hover:text-blue-200">
              {showAdvanced ? '− Hide advanced settings' : '+ Show advanced settings'}
            </button>
            {showAdvanced && (
              <div className="mt-3 grid grid-cols-2 gap-2 rounded-lg bg-gray-900/50 p-3 text-xs text-gray-200">
                {Object.entries({ crop: 'Crop', rotation: 'Rotation', denoise: 'Denoise', sharpen: 'Sharpen', colorGrading: 'Color grading', vignette: 'Vignette', audioEQ: 'Audio EQ', audioCompression: 'Audio compression', loudnessNormalization: '-14 LUFS normalization', pitchTempo: 'Pitch/tempo', lut: 'LUT', subtitles: 'Whisper subtitles', thumbnail: 'Best thumbnail' }).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2">
                    <input type="checkbox" checked={advancedFeatures[key]} onChange={e => setAdvancedFeatures(prev => ({ ...prev, [key]: e.target.checked }))} disabled={isProcessing} />
                    {label}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>

        {errorMessage && (
          <div className="mb-6 flex items-center justify-between gap-4 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300" role="alert">
            <span>{errorMessage}</span>
            <button onClick={() => setErrorMessage('')} className="text-red-300 hover:text-white" aria-label="Dismiss error">
              <XCircle size={18} />
            </button>
          </div>
        )}

        {/* Stats Bar */}
        {jobs.length > 0 && (
          <div className={`flex flex-wrap gap-4 mb-6 p-4 rounded-xl ${darkMode ? 'bg-gray-800/50' : 'bg-gray-100/50'} text-sm`}>
            <div className="flex items-center gap-2">
              <HardDrive size={16} className="text-blue-400" />
              <span>Total: <strong>{jobs.length}</strong></span>
            </div>
            <div className="flex items-center gap-2">
              <CheckCircle size={16} className="text-green-400" />
              <span>Done: <strong>{jobs.filter(j => j.status === 'completed').length}</strong></span>
            </div>
            <div className="flex items-center gap-2">
              <Loader2 size={16} className="text-blue-400 animate-spin" />
              <span>Processing: <strong>{jobs.filter(j => ['queued', 'downloading', 'processing'].includes(j.status)).length}</strong></span>
            </div>
            <div className="flex items-center gap-2">
              <XCircle size={16} className="text-red-400" />
              <span>Failed: <strong>{jobs.filter(j => j.status === 'failed').length}</strong></span>
            </div>
          </div>
        )}

        {/* Jobs Grid */}
        {jobs.length > 0 && (
          <div className={`grid ${viewMode === 'grid' ? 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3' : 'grid-cols-1'} gap-4`}>
            {jobs.map(job => (
              <JobCard key={job.jobId} job={job} />
            ))}
          </div>
        )}

        {/* Empty State */}
        {jobs.length === 0 && !isProcessing && (
          <div className={`text-center py-16 ${darkMode ? 'text-gray-600' : 'text-gray-400'}`}>
            <Film size={64} className="mx-auto mb-4 opacity-30" />
            <p className="text-lg">No videos yet</p>
            <p className="text-sm">Upload videos or paste a URL to get started</p>
          </div>
        )}

        {/* Footer */}
        <div className={`mt-12 pt-6 border-t text-center text-sm ${darkMode ? 'border-gray-800 text-gray-600' : 'border-gray-200 text-gray-400'}`}>
          <p>🔒 All processing happens locally. Files auto-delete after 7 days.</p>
          <p className="mt-1">⚡ Optimized for quality • No login required • Unlimited usage</p>
        </div>
      </div>
    </div>
  );
}

export default App;
