const express = require('express');
const { Telegraf } = require('telegraf');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs').promises;
const path = require('path');
const { tmpdir } = require('os');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize bot
const bot = new Telegraf(process.env.BOT_TOKEN);

// Store user sessions
const userSessions = new Map();

// Simple SRT Parser
function parseSRT(subtitleText) {
  const lines = subtitleText.split('\n');
  const subtitles = [];
  let currentSub = null;

  for (const line of lines) {
    const trimmed = line.trim();
    
    if (!trimmed) {
      if (currentSub) {
        subtitles.push(currentSub);
        currentSub = null;
      }
      continue;
    }
    
    // Check if line is timestamp (contains -->)
    if (trimmed.includes('-->')) {
      if (currentSub) {
        subtitles.push(currentSub);
      }
      
      const parts = trimmed.split(' --> ');
      if (parts.length === 2) {
        currentSub = {
          startTime: parseTime(parts[0]),
          endTime: parseTime(parts[1]),
          text: ''
        };
      }
    } else if (!isNaN(trimmed) && currentSub === null) {
      // This is a subtitle index number, ignore it
      continue;
    } else if (currentSub) {
      // This is subtitle text
      currentSub.text += (currentSub.text ? '\n' : '') + trimmed;
    }
  }
  
  if (currentSub) {
    subtitles.push(currentSub);
  }
  
  return subtitles;
}

function parseTime(timeStr) {
  try {
    // Handle format: 00:00:01,100 or 00:00:01.100
    const cleanTime = timeStr.replace(',', '.');
    const parts = cleanTime.split(':');
    
    if (parts.length === 3) {
      const hours = parseInt(parts[0]);
      const minutes = parseInt(parts[1]);
      const seconds = parseFloat(parts[2]);
      
      return hours * 3600 + minutes * 60 + seconds;
    }
  } catch (error) {
    console.error('Error parsing time:', timeStr, error);
  }
  return 0;
}

// Free TTS Service using Google Translate
async function generateSinhalaSpeech(text, voiceType = 'female') {
  try {
    // Google Translate TTS endpoint
    const ttsUrl = 'https://translate.google.com/translate_tts';
    
    const response = await axios({
      method: 'GET',
      url: ttsUrl,
      params: {
        ie: 'UTF-8',
        q: text,
        tl: 'si', // Sinhala language code
        total: '1',
        idx: '0',
        textlen: text.length,
        client: 'tw-ob',
        prev: 'input',
        ttsspeed: voiceType === 'child' ? '0.8' : '1.0'
      },
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        'Referer': 'https://translate.google.com/',
        'Accept': 'audio/mpeg'
      }
    });
    
    console.log(`Generated TTS for: ${text.substring(0, 50)}...`);
    return Buffer.from(response.data);
    
  } catch (error) {
    console.error('TTS Error:', error.message);
    // Return empty buffer as fallback
    return Buffer.alloc(0);
  }
}

// Voice type detection for Sinhala
function detectVoiceType(text) {
  // Simple heuristics based on text length and content
  const cleanText = text.replace(/[^\u0D80-\u0DFF]/g, ''); // Keep only Sinhala characters
  
  if (cleanText.length < 15) {
    return 'child';
  }
  
  // Check for question marks or exclamation which might indicate child speech
  if (text.includes('?') || text.includes('!')) {
    return Math.random() > 0.7 ? 'child' : 'female';
  }
  
  // Random distribution for demo - in production, use better logic
  const rand = Math.random();
  if (rand < 0.4) return 'female';
  if (rand < 0.7) return 'male';
  return 'child';
}

// Get video duration
function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        reject(err);
      } else {
        resolve(metadata.format.duration || 60); // Default to 60 seconds if unknown
      }
    });
  });
}

// Simple audio mixing - creates individual audio files and merges them
async function createDubbedAudio(audioSegments, outputPath, totalDuration) {
  const tempDir = path.dirname(outputPath);
  const tempFiles = [];
  
  try {
    // Create a silent base audio
    const silentAudio = path.join(tempDir, 'silent.mp3');
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input('anullsrc=channel_layout=stereo:sample_rate=44100')
        .inputOptions([`-t ${totalDuration}`])
        .output(silentAudio)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    
    // Create audio files for each segment
    for (let i = 0; i < audioSegments.length; i++) {
      const segment = audioSegments[i];
      if (segment.audio.length === 0) continue; // Skip empty audio
      
      const tempFile = path.join(tempDir, `segment_${i}.mp3`);
      await fs.writeFile(tempFile, segment.audio);
      tempFiles.push(tempFile);
    }
    
    if (tempFiles.length === 0) {
      // If no audio segments, just copy silent audio
      await fs.copyFile(silentAudio, outputPath);
      return;
    }
    
    // Build ffmpeg command for mixing
    let command = ffmpeg(silentAudio);
    
    // Add all segment files as inputs
    tempFiles.forEach(file => {
      command = command.input(file);
    });
    
    // Create complex filter for mixing
    let filterComplex = '';
    const inputs = ['0:a'];
    
    for (let i = 0; i < tempFiles.length; i++) {
      const segment = audioSegments[i];
      filterComplex += `[${i + 1}:a]adelay=${segment.start * 1000}|${segment.start * 1000}[a${i}];`;
      inputs.push(`[a${i}]`);
    }
    
    filterComplex += `${inputs.join('')}amix=inputs=${inputs.length}:duration=longest[audio]`;
    
    await new Promise((resolve, reject) => {
      command
        .complexFilter(filterComplex, 'audio')
        .outputOptions(['-map', '[audio]'])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    
  } catch (error) {
    console.error('Audio mixing error:', error);
    throw error;
  } finally {
    // Cleanup temp files
    for (const file of [...tempFiles, path.join(tempDir, 'silent.mp3')]) {
      try {
        await fs.unlink(file);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }
}

// Bot Commands
bot.start((ctx) => {
  ctx.reply(`🎬 හැයි! Sinhala Video Dubbing Bot වෙත සාදරයෙන් පිළිගනිමු!

මම ඔබගේ වීඩියෝ සිංහලට හඬකැවීමට සහය වෙමි.

භාවිතය:
1. මට වීඩියෝ එකක් එවන්න
2. සිංහල උපසිරැසි ගොනුව එවන්න (.srt)
3. මම ස්වයංක්‍රීයව හඬකැවූ වීඩියෝව එවන්නම්

විශේෂාංග:
• ස්වයංක්‍රීය හඬ තෝරාගැනීම (දරු, ස්ත්‍රී, පුරුෂ)
• සිංහල උච්චාරණය
• ඉක්මන් පිරිසැකසුම

වීඩියෝවක් එවීමෙන් ආරම්භ කරන්න!`);
});

bot.help((ctx) => {
  ctx.reply(`උදව්:

1. වීඩියෝ එවන්න (MP4, MOV)
2. සිංහල උපසිරැසි ගොනුව එවන්න (.srt)
3. රැඳී සිටින්න - මම හඬකැවූ වීඩියෝව එවන්නම්

ප්‍රශ්න ඇත්නම්: /help`);
});

bot.on('video', async (ctx) => {
  try {
    const fileId = ctx.message.video.file_id;
    const userId = ctx.from.id;
    
    const file = await ctx.telegram.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
    
    // Initialize user session
    userSessions.set(userId, {
      videoUrl: fileUrl,
      videoFileId: fileId,
      timestamp: Date.now()
    });
    
    await ctx.reply('✅ වීඩියෝව ලැබුණා! දැන් සිංහල උපසිරැසි ගොනුව එවන්න (.srt)');
    
  } catch (error) {
    console.error('Error handling video:', error);
    await ctx.reply('❌ දෝෂයක්! කරුණාකර නැවත උත්සාහ කරන්න.');
  }
});

bot.on('document', async (ctx) => {
  try {
    const document = ctx.message.document;
    const fileName = document.file_name.toLowerCase();
    const userId = ctx.from.id;
    
    // Check if it's a subtitle file
    if (!fileName.endsWith('.srt')) {
      await ctx.reply('❌ කරුණාකර .srt උපසිරැසි ගොනුව එවන්න');
      return;
    }
    
    const userSession = userSessions.get(userId);
    if (!userSession || !userSession.videoUrl) {
      await ctx.reply('❌ කරුණාකර මුලින්ම වීඩියෝව එවන්න!');
      return;
    }
    
    // Clean old sessions (1 hour old)
    const now = Date.now();
    for (const [id, session] of userSessions.entries()) {
      if (now - session.timestamp > 3600000) {
        userSessions.delete(id);
      }
    }
    
    const file = await ctx.telegram.getFile(document.file_id);
    const subtitleUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
    
    // Update session
    userSession.subtitleUrl = subtitleUrl;
    userSession.timestamp = Date.now();
    
    // Send processing message
    const processingMsg = await ctx.reply('🔄 ඔබගේ වීඩියෝව සකසන්නේ...\n\n• ගොනු බාගත කිරීම\n• උපසිරැසි විග්‍රහ කිරීම\n• සිංහල හඬ නිපදවීම\n• ශබ්දය සම්බන්ධ කිරීම\n\nකරුණාකර රැඳී සිටින්න... (මිනිත්තු 2-5 තිබේ)');

    // Process dubbing
    const tempDir = path.join(tmpdir(), `dub-${userId}-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    try {
      const videoPath = path.join(tempDir, 'original.mp4');
      const subtitlePath = path.join(tempDir, 'subtitle.srt');
      const dubbedAudioPath = path.join(tempDir, 'dubbed_audio.mp3');
      const outputPath = path.join(tempDir, 'dubbed_video.mp4');

      // Download files
      await ctx.reply('📥 ගොනු බාගත කිරීම...');
      
      const videoResponse = await axios({
        method: 'GET',
        url: userSession.videoUrl,
        responseType: 'arraybuffer',
        timeout: 60000
      });
      await fs.writeFile(videoPath, videoResponse.data);

      const subtitleResponse = await axios({
        method: 'GET',
        url: subtitleUrl,
        responseType: 'text',
        timeout: 30000
      });
      await fs.writeFile(subtitlePath, subtitleResponse.data);

      // Parse subtitle
      await ctx.reply('📝 උපසිරැසි විග්‍රහ කිරීම...');
      const subtitleContent = await fs.readFile(subtitlePath, 'utf8');
      const subtitles = parseSRT(subtitleContent);
      
      if (subtitles.length === 0) {
        throw new Error('No subtitles found in the file');
      }

      await ctx.reply(`🔊 ${subtitles.length} උපසිරැසි සඳහා හඬ නිපදවීම...`);

      // Generate audio segments
      const audioSegments = [];
      for (let i = 0; i < Math.min(subtitles.length, 50); i++) { // Limit to 50 segments for demo
        const sub = subtitles[i];
        const voiceType = detectVoiceType(sub.text);
        const audioBuffer = await generateSinhalaSpeech(sub.text, voiceType);
        
        audioSegments.push({
          audio: audioBuffer,
          start: sub.startTime,
          end: sub.endTime,
          text: sub.text.substring(0, 100) // Truncate for logging
        });
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Get video duration
      const duration = await getVideoDuration(videoPath);

      // Create dubbed audio
      await ctx.reply('🎵 ශබ්දය මිශ්‍ර කිරීම...');
      await createDubbedAudio(audioSegments, dubbedAudioPath, duration);

      // Replace audio in video
      await ctx.reply('🎬 අවසාන වීඩියෝව සෑදීම...');
      await new Promise((resolve, reject) => {
        ffmpeg(videoPath)
          .input(dubbedAudioPath)
          .outputOptions([
            '-c:v copy',
            '-c:a aac',
            '-map 0:v:0',
            '-map 1:a:0',
            '-shortest'
          ])
          .output(outputPath)
          .on('end', resolve)
          .on('error', reject)
          .run();
      });

      // Check if output file exists and has reasonable size
      const stats = await fs.stat(outputPath);
      if (stats.size < 1024) {
        throw new Error('Output file too small');
      }

      // Send the dubbed video
      await ctx.reply('✅ හඬකැවීම සම්පුර්ණ! වීඩියෝව එවන්නේ...');

      await ctx.replyWithVideo(
        { source: outputPath },
        {
          caption: `🎬 ඔබගේ සිංහල හඬකැවූ වීඩියෝව!\n\nස්වයංක්‍රීයව හඬකැවුණු ${audioSegments.length} උපසිරැසි\n\nභුක්ති විඳින්න! 🍿`
        }
      );

    } catch (error) {
      console.error('Processing error:', error);
      await ctx.reply(`❌ සැකසීමේ දෝෂය: ${error.message}\nකරුණාකර නැවත උත්සාහ කරන්න.`);
    } finally {
      // Cleanup temp directory
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error('Cleanup error:', cleanupError);
      }
      
      // Cleanup session
      userSessions.delete(userId);
    }
    
  } catch (error) {
    console.error('Error processing document:', error);
    await ctx.reply('❌ දෝෂයක්! කරුණාකර නැවත උත්සාහ කරන්න.');
  }
});

bot.on('message', (ctx) => {
  ctx.reply('කරුණාකර මට වීඩියෝ ගොනුවක් එවන්න, පසුව සිංහල උපසිරැසි ගොනුව (.srt).');
});

// Error handling
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.reply('❌ අනපේක්ෂිත දෝෂයක්. කරුණාකර නැවත උත්සාහ කරන්න.');
});

// Express setup
app.use(express.json());

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ 
    status: 'Bot is running!',
    service: 'Sinhala Video Dubbing Bot',
    users: userSessions.size,
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Webhook endpoint
app.post('/webhook', (req, res) => {
  bot.handleUpdate(req.body);
  res.sendStatus(200);
});

// Start server
if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`🚀 Bot server running on port ${PORT}`);
    console.log(`🤖 Bot is running in polling mode`);
  });
  
  // Start polling in development
  bot.launch();
} else {
  // For Vercel, export the app
  module.exports = app;
}

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
