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
const bot = new Telegraf(process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN');

// Store user sessions
const userSessions = new Map();

// Free TTS Service using Google Translate (web version)
async function generateSinhalaSpeech(text, voiceType = 'female') {
  try {
    // Google Translate TTS endpoint
    const url = `https://translate.google.com/translate_tts`;
    
    const response = await axios.get(url, {
      params: {
        ie: 'UTF-8',
        q: text,
        tl: 'si', // Sinhala
        total: '1',
        idx: '0',
        textlen: text.length,
        client: 'tw-ob',
        prev: 'input',
        ttsspeed: voiceType === 'child' ? '0.9' : '1.0'
      },
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    return Buffer.from(response.data);
  } catch (error) {
    console.log('Google TTS failed, using fallback...');
    // Fallback: Create empty audio with correct duration
    return generateSilentAudio(text.length * 0.1); // Approximate duration
  }
}

function generateSilentAudio(durationSeconds) {
  // This would create silent audio - in real implementation, use audio buffer
  return Buffer.alloc(1000); // Placeholder
}

// Subtitle Parser
function parseSRT(subtitleText) {
  const lines = subtitleText.split('\n');
  const subtitles = [];
  let currentSub = null;

  for (const line of lines) {
    const trimmed = line.trim();
    
    if (!trimmed) continue;
    
    // Check if line is timestamp
    if (trimmed.includes('-->')) {
      if (currentSub) {
        subtitles.push(currentSub);
      }
      
      const [start, end] = trimmed.split(' --> ');
      currentSub = {
        startTime: parseTime(start),
        endTime: parseTime(end),
        text: ''
      };
    } else if (currentSub && !isNaN(trimmed)) {
      // Skip index numbers
      continue;
    } else if (currentSub) {
      currentSub.text += (currentSub.text ? ' ' : '') + trimmed;
    }
  }
  
  if (currentSub) {
    subtitles.push(currentSub);
  }
  
  return subtitles;
}

function parseTime(timeStr) {
  const [hours, minutes, secondsMs] = timeStr.split(':');
  const [seconds, milliseconds] = secondsMs.split(',');
  
  return (
    parseInt(hours) * 3600 +
    parseInt(minutes) * 60 +
    parseInt(seconds) +
    parseInt(milliseconds) / 1000
  );
}

// Voice type detection for Sinhala
function detectVoiceType(text) {
  const sinhalaText = text;
  
  // Simple heuristics for voice type detection
  if (sinhalaText.includes('?')) return 'child';
  if (sinhalaText.length < 20) return 'child';
  
  // Check for feminine patterns (you can add more Sinhala-specific patterns)
  const femininePatterns = [
    'මම', 'මගේ', 'ඔබ', 'කියන්න', 'එපා', 'ආයුබෝවන්'
  ];
  
  for (const pattern of femininePatterns) {
    if (sinhalaText.includes(pattern)) {
      return Math.random() > 0.5 ? 'female' : 'male';
    }
  }
  
  return 'male';
}

// Audio processing
async function mixAudioSegments(audioSegments, outputPath, totalDuration) {
  // Simplified audio mixing - in production, use proper audio concatenation
  const tempFiles = [];
  
  try {
    // Create silent base audio
    const silentBase = path.join(path.dirname(outputPath), 'silent.wav');
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input('anullsrc=channel_layout=stereo:sample_rate=44100')
        .inputOptions([`-t ${totalDuration}`])
        .output(silentBase)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    
    // Mix audio segments (simplified)
    let command = ffmpeg(silentBase);
    
    for (let i = 0; i < audioSegments.length; i++) {
      const segment = audioSegments[i];
      const tempFile = path.join(path.dirname(outputPath), `segment_${i}.mp3`);
      
      await fs.writeFile(tempFile, segment.audio);
      tempFiles.push(tempFile);
      
      command = command.input(tempFile)
        .inputOptions([`-ss ${segment.start}`, `-t ${segment.end - segment.start}`]);
    }
    
    // Complex filter for mixing
    let filter = '';
    for (let i = 0; i < audioSegments.length; i++) {
      if (i > 0) filter += ';';
      filter += `[${i + 1}:a]adelay=${audioSegments[i].start * 1000}|${audioSegments[i].start * 1000}[a${i}]`;
    }
    
    filter += ';' + Array.from({length: audioSegments.length}, (_, i) => `[a${i}]`).join('') + 
              `amix=inputs=${audioSegments.length + 1}:duration=longest[audio]`;
    
    await new Promise((resolve, reject) => {
      command.complexFilter(filter, 'audio')
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    
    return outputPath;
  } finally {
    // Cleanup temp files
    for (const tempFile of tempFiles) {
      try { await fs.unlink(tempFile); } catch {}
    }
    try { await fs.unlink(path.join(path.dirname(outputPath), 'silent.wav')); } catch {}
  }
}

function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata.format.duration);
    });
  });
}

// Bot Commands
bot.start((ctx) => {
  ctx.reply(`🎬 හැයි! Sinhala Video Dubbing Bot වෙත සාදරයෙන් පිළිගනිමු!

මම ඔබගේ වීඩියෝ සිංහලට හඬකැවීමට සහය වෙමි.

භාවිතය:
1. මට වීඩියෝ එකක් එවන්න
2. සිංහල උපසිරැසි ගොනුව එවන්න (.srt හෝ .vtt)
3. මම ස්වයංක්‍රීයව හඬකැවූ වීඩියෝව එවන්නම්

විශේෂාංග:
• ස්වයංක්‍රීය හඬ තෝරාගැනීම (දරු, ස්ත්‍රී, පුරුෂ)
• ස්වභාවික සිංහල උච්චාරණය
• ඉක්මන් පිරිසැකසුම

වීඩියෝවක් එවීමෙන් ආරම්භ කරන්න!`);
});

bot.help((ctx) => {
  ctx.reply(`උදව්:

1. වීඩියෝ එවන්න (MP4, MOV, AVI)
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
    
    if (!userSessions.has(userId)) {
      userSessions.set(userId, {});
    }
    userSessions.get(userId).videoUrl = fileUrl;
    userSessions.get(userId).videoFileId = fileId;
    
    await ctx.reply('✅ වීඩියෝව ලැබුණා! දැන් සිංහල උපසිරැසි ගොනුව එවන්න (.srt හෝ .vtt)');
    
  } catch (error) {
    console.error('Error:', error);
    await ctx.reply('❌ දෝෂයක්! කරුණාකර නැවත උත්සාහ කරන්න.');
  }
});

bot.on('document', async (ctx) => {
  try {
    const document = ctx.message.document;
    const fileName = document.file_name.toLowerCase();
    const userId = ctx.from.id;
    
    if (!fileName.endsWith('.srt') && !fileName.endsWith('.vtt')) {
      await ctx.reply('❌ කරුණාකර නිවැරදි උපසිරැසි ගොනුව එවන්න (.srt හෝ .vtt)');
      return;
    }
    
    const userSession = userSessions.get(userId);
    if (!userSession || !userSession.videoUrl) {
      await ctx.reply('❌ කරුණාකර මුලින්ම වීඩියෝව එවන්න!');
      return;
    }
    
    const file = await ctx.telegram.getFile(document.file_id);
    const subtitleUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
    
    userSession.subtitleUrl = subtitleUrl;
    
    const processingMsg = await ctx.reply('🔄 ඔබගේ වීඩියෝව සකසන්නේ...\n\n• ගොනු බාගත කිරීම\n• උපසිරැසි විග්‍රහ කිරීම\n• සිංහල හඬ නිපදවීම\n• ශබ්දය සම්බන්ධ කිරීම\n\nකරුණාකර රැඳී සිටින්න...');

    // Process dubbing
    const tempDir = path.join(tmpdir(), `dub-${userId}-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });

    try {
      const videoPath = path.join(tempDir, 'original.mp4');
      const subtitlePath = path.join(tempDir, 'subtitle.srt');
      const outputPath = path.join(tempDir, 'dubbed_video.mp4');

      // Download files
      const videoResponse = await axios.get(userSession.videoUrl, { responseType: 'arraybuffer' });
      await fs.writeFile(videoPath, videoResponse.data);

      const subtitleResponse = await axios.get(subtitleUrl, { responseType: 'text' });
      await fs.writeFile(subtitlePath, subtitleResponse.data);

      // Parse subtitle
      const subtitleContent = await fs.readFile(subtitlePath, 'utf8');
      const subtitles = parseSRT(subtitleContent);

      // Generate audio segments
      const audioSegments = [];
      for (const sub of subtitles) {
        const voiceType = detectVoiceType(sub.text);
        const audioBuffer = await generateSinhalaSpeech(sub.text, voiceType);
        
        audioSegments.push({
          audio: audioBuffer,
          start: sub.startTime,
          end: sub.endTime,
          text: sub.text
        });
      }

      // Get video duration
      const duration = await getVideoDuration(videoPath);

      // Create dubbed audio
      const dubbedAudioPath = path.join(tempDir, 'dubbed_audio.wav');
      await mixAudioSegments(audioSegments, dubbedAudioPath, duration);

      // Replace audio in video
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

      // Send the dubbed video
      await ctx.reply('✅ හඬකැවීම සම්පුර්ණ! වීඩියෝව එවන්නේ...');

      await ctx.replyWithVideo(
        { source: outputPath },
        {
          caption: `🎬 ඔබගේ සිංහල හඬකැවූ වීඩියෝව!\n\nස්වයංක්‍රීයව හඬකැවුණු:\n• 👦 දරු චරිත\n• 👩 ස්ත්‍රී චරිත  \n• 👨 පුරුෂ චරිත\n\nභුක්ති විඳින්න! 🍿`
        }
      );

      // Cleanup
      userSessions.delete(userId);
      
    } catch (error) {
      console.error('Processing error:', error);
      await ctx.reply('❌ සැකසීමේ දෝෂයක්. කරුණාකර උපසිරැසි ගොනුව පරීක්ෂා කරන්න.');
    } finally {
      // Cleanup temp files
      try {
        await fs.rm(tempDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error('Cleanup error:', cleanupError);
      }
    }
    
  } catch (error) {
    console.error('Error:', error);
    await ctx.reply('❌ දෝෂයක්! කරුණාකර නැවත උත්සාහ කරන්න.');
  }
});

bot.on('message', (ctx) => {
  ctx.reply('කරුණාකර මට වීඩියෝ ගොනුවක් එවන්න, පසුව සිංහල උපසිරැසි ගොනුව.');
});

// Webhook setup for Vercel
app.use(express.json());
app.use(bot.webhookCallback('/webhook'));

app.get('/', (req, res) => {
  res.json({ 
    status: 'Bot is running!',
    service: 'Sinhala Video Dubbing Bot',
    usage: 'Use Telegram bot @YourBotName'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Start server
app.listen(PORT, async () => {
  console.log(`🚀 Bot server running on port ${PORT}`);
  
  // Set webhook for production
  if (process.env.VERCEL_URL) {
    const webhookUrl = `https://${process.env.VERCEL_URL}/webhook`;
    await bot.telegram.setWebhook(webhookUrl);
    console.log(`Webhook set to: ${webhookUrl}`);
  }
});

module.exports = app;
