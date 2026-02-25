import express from 'express';
import puppeteer from 'puppeteer';
import ffmpeg from 'fluent-ffmpeg';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Render service running' });
});

// Render endpoint
app.post('/render', async (req, res) => {
  const { projectId, userId, animationCode, resolution = '1080p', fps = 30 } = req.body;
  
  console.log(`Starting render for project ${projectId}`);
  
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
  
  const dimensions = resolution === '1080p' 
    ? { width: 1920, height: 1080 }
    : { width: 1280, height: 720 };
    
  const tempDir = `/tmp/render-${projectId}-${Date.now()}`;
  const frameDir = path.join(tempDir, 'frames');
  
  let browser;
  
  try {
    // Create temp directories
    fs.mkdirSync(frameDir, { recursive: true });
    
    // Create HTML with React component
    const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/framer-motion@11/dist/framer-motion.js"></script>
  <style>
    body { margin: 0; padding: 0; overflow: hidden; }
    #root { width: ${dimensions.width}px; height: ${dimensions.height}px; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module">
    const { motion } = Motion;
    
    ${animationCode}
    
    const root = ReactDOM.createRoot(document.getElementById('root'));
    root.render(React.createElement(AnimatedVideo));
  </script>
</body>
</html>`;

    // Launch Puppeteer
    console.log('Launching browser...');
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
      ]
    });
    
    const page = await browser.newPage();
    await page.setViewport(dimensions);
    
    // Load animation
    console.log('Loading animation...');
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.waitForTimeout(1000);
    
    // Capture frames
    const duration = 30;
    const totalFrames = duration * fps;
    const frameInterval = 1000 / fps;
    
    console.log(`Capturing ${totalFrames} frames...`);
    
    for (let i = 0; i < totalFrames; i++) {
      const framePath = path.join(frameDir, `frame-${String(i).padStart(5, '0')}.png`);
      await page.screenshot({
        path: framePath,
        type: 'png'
      });
      await page.waitForTimeout(frameInterval);
      
      if (i % Math.floor(totalFrames / 10) === 0) {
        console.log(`Progress: ${Math.floor((i / totalFrames) * 100)}%`);
      }
    }
    
    await browser.close();
    console.log('Frames captured successfully');
    
    // Convert to video with FFmpeg
    const outputPath = path.join(tempDir, 'output.mp4');
    
    console.log('Encoding video with FFmpeg...');
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(path.join(frameDir, 'frame-%05d.png'))
        .inputFPS(fps)
        .videoCodec('libx264')
        .outputOptions([
          '-pix_fmt yuv420p',
          '-preset medium',
          '-crf 23'
        ])
        .output(outputPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });
    
    console.log('Video encoded successfully');
    
    // Upload to Supabase
    const videoBuffer = fs.readFileSync(outputPath);
    const fileName = `${userId}/${projectId}/video-${Date.now()}.mp4`;
    
    console.log('Uploading to Supabase...');
    const { error: uploadError } = await supabase.storage
      .from('videos')
      .upload(fileName, videoBuffer, {
        contentType: 'video/mp4',
        upsert: true
      });
      
    if (uploadError) throw uploadError;
    
    const { data: { publicUrl } } = supabase.storage
      .from('videos')
      .getPublicUrl(fileName);
    
    console.log('Upload complete:', publicUrl);
    
    // Cleanup
    fs.rmSync(tempDir, { recursive: true, force: true });
    
    res.json({
      success: true,
      videoUrl: publicUrl
    });
    
  } catch (error) {
    console.error('Render error:', error);
    
    if (browser) await browser.close();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Render service running on port ${PORT}`);
});
