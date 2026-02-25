import express from 'express';
import { bundle } from '@remotion/bundler';
import { renderMedia, selectComposition } from '@remotion/renderer';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.json({ status: 'Remotion render service running' });
});

app.post('/render', async (req, res) => {
  // Auth check
  const authHeader = req.headers.authorization;
  const expectedSecret = process.env.RENDER_SECRET;
  
  if (!authHeader || authHeader !== `Bearer ${expectedSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const { 
    projectId, 
    userId, 
    compositionCode,
    fps = 30,
    durationInFrames = 900,
    width = 1920,
    height = 1080
  } = req.body;
  
  console.log(`Starting Remotion render for project ${projectId}`);
  
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );
  
  const tempDir = `/tmp/remotion-${projectId}-${Date.now()}`;
  
  try {
    // Create temp directory
    fs.mkdirSync(tempDir, { recursive: true });
    
    // Create Remotion project structure
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    
    // Write composition file
    const compositionFile = path.join(srcDir, 'Composition.jsx');
    fs.writeFileSync(compositionFile, compositionCode);
    
    // Create index file that exports the composition
    const indexFile = path.join(srcDir, 'index.js');
    fs.writeFileSync(indexFile, `
      import { Composition } from 'remotion';
      import { MyComposition } from './Composition';
      
      export const RemotionRoot = () => {
        return (
          <Composition
            id="Main"
            component={MyComposition}
            durationInFrames={${durationInFrames}}
            fps={${fps}}
            width={${width}}
            height={${height}}
          />
        );
      };
    `);
    
    // Create package.json
    const packageJson = {
      name: 'remotion-render',
      version: '1.0.0',
      type: 'module',
      dependencies: {
        'remotion': '^4.0.0',
        'react': '^18.2.0',
        'react-dom': '^18.2.0'
      }
    };
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify(packageJson, null, 2)
    );
    
    console.log('Bundling Remotion composition...');
    
    // Bundle the Remotion project
    const bundleLocation = await bundle({
      entryPoint: indexFile,
      webpackOverride: (config) => config,
    });
    
    console.log('Bundle created, selecting composition...');
    
    // Get composition
    const composition = await selectComposition({
      serveUrl: bundleLocation,
      id: 'Main',
    });
    
    console.log('Rendering video...');
    
    const outputPath = path.join(tempDir, 'output.mp4');
    
    // Render the video
    await renderMedia({
      composition,
      serveUrl: bundleLocation,
      codec: 'h264',
      outputLocation: outputPath,
      onProgress: ({ progress }) => {
        console.log(`Render progress: ${Math.round(progress * 100)}%`);
      },
    });
    
    console.log('Render complete, uploading to Supabase...');
    
    // Upload to Supabase
    const videoBuffer = fs.readFileSync(outputPath);
    const fileName = `${userId}/${projectId}/video-${Date.now()}.mp4`;
    
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
  console.log(`Remotion render service running on port ${PORT}`);
});
