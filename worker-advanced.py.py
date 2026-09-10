#!/usr/bin/env python3
"""
Advanced Video Processing Worker
- Batch processing
- Multiple formats
- Quality preservation
- AI-enhanced fingerprint destruction
"""

import os
import sys
import json
import subprocess
import time
import logging
import hashlib
import random
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, ProcessPoolExecutor
import numpy as np
from moviepy.editor import VideoFileClip, AudioFileClip, CompositeVideoClip, TextClip
from moviepy.video.fx import resize, crop, rotate
from moviepy.audio.fx import audio_normalize
from pydub import AudioSegment
from pydub.effects import normalize, speedup
try:
    from pydub.effects import slowdown
except ImportError:
    def slowdown(sound, playback_speed=1.0):
        """Compatibility fallback for pydub releases without slowdown()."""
        if playback_speed <= 0:
            raise ValueError("playback_speed must be positive")
        return speedup(sound, playback_speed=playback_speed)
from pydub.generators import WhiteNoise
import redis
from rq import Worker, Queue, Connection
import ffmpeg

# ==================== CONFIG ====================
REDIS_URL = "redis://localhost:6379"
QUEUE_NAME = "videoProcessing"
LOG_FILE = "worker.log"

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[logging.FileHandler(LOG_FILE), logging.StreamHandler()]
)

# Advanced configuration with randomization
def get_randomized_config():
    """Return randomized config to avoid pattern detection"""
    return {
        "pitch_semitones": round(random.uniform(1.8, 3.2), 1),
        "tempo_multiplier": round(random.uniform(1.05, 1.15), 3),
        "bass_boost_db": round(random.uniform(2.0, 4.0), 1),
        "treble_cut_db": round(random.uniform(-3.0, -1.0), 1),
        "crop_percent": round(random.uniform(0.02, 0.05), 3),
        "rotation_degrees": round(random.uniform(0.3, 0.8), 1),
        "contrast_factor": round(random.uniform(1.05, 1.2), 2),
        "saturation_factor": round(random.uniform(1.05, 1.25), 2),
        "noise_volume_db": round(random.uniform(-30, -20), 1),
        "target_fps": random.choice([29.97, 30, 25, 24]),
        "mirror": random.choice([True, False]),
    }

def advanced_fingerprint_killer(input_path, output_path):
    """
    Enhanced version of fingerprint destruction with random parameters
    """
    config = get_randomized_config()
    logging.info(f"Using config: {config}")
    
    try:
        # Load video
        video = VideoFileClip(input_path)
        
        # --- VIDEO PROCESSING ---
        w, h = video.size
        crop_margin = int(min(w, h) * config["crop_percent"])
        cropped = video.crop(x1=crop_margin, y1=crop_margin, 
                             x2=w-crop_margin, y2=h-crop_margin)
        
        if config["mirror"]:
            cropped = cropped.flip(left_right=True)
        
        if config["rotation_degrees"] != 0:
            cropped = cropped.rotate(config["rotation_degrees"], expand=False)
        
        # Color adjustment
        def adjust_color(frame):
            frame = frame.astype(np.float32) / 255.0
            mean = np.mean(frame, axis=(0,1), keepdims=True)
            frame = (frame - mean) * config["contrast_factor"] + mean
            gray = np.mean(frame, axis=2, keepdims=True)
            frame = gray + (frame - gray) * config["saturation_factor"]
            return np.clip(frame * 255, 0, 255).astype(np.uint8)
        
        cropped = cropped.fl_image(adjust_color)
        cropped = cropped.set_fps(config["target_fps"])
        
        # --- AUDIO PROCESSING ---
        temp_audio = "/tmp/temp_audio.wav"
        video.audio.write_audiofile(temp_audio, fps=video.audio.fps, nbytes=2, codec='pcm_s16le')
        
        sound = AudioSegment.from_wav(temp_audio)
        
        # Pitch shift
        pitch_factor = 2 ** (config["pitch_semitones"] / 12.0)
        new_rate = int(sound.frame_rate * pitch_factor)
        sound = sound._spawn(sound.raw_data, overrides={"frame_rate": new_rate})
        sound = sound.set_frame_rate(sound.frame_rate)
        
        # Tempo
        if config["tempo_multiplier"] > 1.0:
            sound = speedup(sound, playback_speed=config["tempo_multiplier"])
        else:
            sound = slowdown(sound, playback_speed=1.0/config["tempo_multiplier"])
        
        # EQ
        sound = sound.low_pass_filter(300).apply_gain(config["bass_boost_db"])
        sound = sound.high_pass_filter(5000).apply_gain(config["treble_cut_db"])
        
        # Phase inversion (if stereo)
        if sound.channels == 2:
            left = sound.split_to_mono()[0]
            right = sound.split_to_mono()[1].invert_phase()
            sound = AudioSegment.from_mono_audiosegments(left, right)
        
        # White noise
        noise = WhiteNoise().to_audio_segment(duration=len(sound))
        noise = noise.apply_gain(config["noise_volume_db"])
        sound = sound.overlay(noise)
        
        sound = normalize(sound)
        sound.export(temp_audio, format="wav")
        
        # Combine
        new_audio = AudioFileClip(temp_audio)
        final_video = cropped.set_audio(new_audio)
        
        # Export with high quality
        final_video.write_videofile(
            output_path,
            codec='libx264',
            audio_codec='aac',
            fps=config["target_fps"],
            bitrate='8000k',  # High quality
            audio_bitrate='192k',
            threads=4,
            preset='slow'
        )
        
        # Cleanup
        video.close()
        cropped.close()
        final_video.close()
        os.remove(temp_audio)
        
        logging.info(f"✅ Processed: {output_path}")
        return True
        
    except Exception as e:
        logging.error(f"Processing error: {str(e)}")
        raise

def process_video_job(job_id, input_path, output_path, original_name, socket_id=None):
    """
    Main job handler
    """
    try:
        logging.info(f"[{job_id}] Starting: {original_name}")
        
        # Process
        success = advanced_fingerprint_killer(input_path, output_path)
        
        if success:
            # Calculate file hash for verification
            with open(output_path, 'rb') as f:
                file_hash = hashlib.md5(f.read()).hexdigest()
            
            return {
                "status": "completed",
                "outputPath": output_path,
                "jobId": job_id,
                "hash": file_hash,
                "size": os.path.getsize(output_path)
            }
        else:
            raise Exception("Processing failed")
            
    except Exception as e:
        logging.error(f"[{job_id}] Error: {str(e)}")
        raise
    finally:
        # Cleanup input after processing (optional)
        pass

# ==================== WORKER MAIN ====================
if __name__ == "__main__":
    with Connection(redis.from_url(REDIS_URL)):
        worker = Worker(
            QUEUE_NAME,
            connection=redis.from_url(REDIS_URL)
        )
        worker.work(with_scheduler=True)
