'use strict'

const fs = require("fs");
const os = require("os");
const path = require('path');
const {encode: encodeQuery} = require('querystring');
const {strictEqual} = require('assert');
const envPaths = require('env-paths');
const FileCache = require('@derhuerst/http-basic/lib/FileCache').default;
const {extname} = require('path');
const ProgressBar = require("progress");
const request = require('@derhuerst/http-basic');
const {createGunzip} = require('zlib');
const {pipeline} = require('stream');
const { spawn } = require('child_process');
const yauzl = require('yauzl');
const mkdirp = require('mkdirp');
let {ffmpegPath, ffprobePath} = require(".");
const pkg = require("./package");

const exitOnError = (err) => {
  console.error(err);
  process.exit(1);
};

const warnWith = (msg) => () => {
  console.warn(msg);
};

// Check if binaries already exist
if (ffmpegPath && ffprobePath) {
  try {
    if (fs.statSync(ffmpegPath).isFile() && fs.statSync(ffprobePath).isFile()) {
      console.info('ffmpeg/ffprobe is installed already.');
      process.exit(0);
    }
  } catch (err) {
    if (err && err.code !== 'ENOENT') exitOnError(err);
  }
}

// Configure proxy if needed
let agent = false;
const proxyUrl = (
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy
);
if (proxyUrl) {
  const HttpsProxyAgent = require('https-proxy-agent');
  const {hostname, port, protocol} = new URL(proxyUrl);
  agent = new HttpsProxyAgent({hostname, port, protocol});
}

// Normalize S3 URLs
const normalizeS3Url = (url) => {
  url = new URL(url);
  if (url.hostname.slice(-17) !== '.s3.amazonaws.com') return url.href;
  const query = Array.from(url.searchParams.entries())
    .filter(([key]) => key.slice(0, 6).toLowerCase() !== 'x-amz-')
    .reduce((query, [key, val]) => ({...query, [key]: val}), {});
  url.search = encodeQuery(query);
  return url.href;
};

strictEqual(
  normalizeS3Url('https://example.org/foo?bar'),
  'https://example.org/foo?bar'
);
strictEqual(
  normalizeS3Url('https://github-production-release-asset-2e65be.s3.amazonaws.com/29458513/26341680-4231-11ea-8e36-ae454621d74a?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIWNJYAX4CSVEH53A%2F20200405%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20200405T225358Z&X-Amz-Expires=300&X-Amz-Signature=d6415097af04cf62ea9b69d3c1a421278e96bcb069afa48cf021ec3b6941bae4&X-Amz-SignedHeaders=host&actor_id=0&response-content-disposition=attachment%3B%20filename%3Ddarwin-x64&response-content-type=application%2Foctet-stream'),
  'https://github-production-release-asset-2e65be.s3.amazonaws.com/29458513/26341680-4231-11ea-8e36-ae454621d74a?actor_id=0&response-content-disposition=attachment%3B%20filename%3Ddarwin-x64&response-content-type=application%2Foctet-stream'
);

// Configure cache
const cache = new FileCache(envPaths(pkg.name).cache);
cache.getCacheKey = (url) => {
  return FileCache.prototype.getCacheKey(normalizeS3Url(url));
};

const isGzUrl = (url) => {
  const path = new URL(url).pathname.split('/');
  const filename = path[path.length - 1];
  return filename && extname(filename) === '.gz';
};

const noop = () => {};

// Download file with progress reporting
function downloadFile(url, destinationPath, progressCallback = noop) {
  let fulfill, reject;
  let totalBytes = 0;

  const promise = new Promise((x, y) => {
    fulfill = x;
    reject = y;
  });

  request('GET', url, {
    agent,
    followRedirects: true,
    maxRedirects: 3,
    gzip: true,
    cache,
    timeout: 30 * 1000, // 30s
    retry: true,
  }, (err, response) => {
    if (err || response.statusCode !== 200) {
      err = err || new Error('Download failed.');
      if (response) {
        err.url = response.url;
        err.statusCode = response.statusCode;
      }
      reject(err);
      return;
    }

    const file = fs.createWriteStream(destinationPath);
    const streams = isGzUrl(url)
      ? [response.body, createGunzip(), file]
      : [response.body, file];
    pipeline(
      ...streams,
      (err) => {
        if (err) {
          err.url = response.url;
          err.statusCode = response.statusCode;
          reject(err);
        } else fulfill();
      }
    );

    if (!response.fromCache && progressCallback) {
      const cLength = response.headers["content-length"];
      totalBytes = cLength ? parseInt(cLength, 10) : null;
      response.body.on('data', (chunk) => {
        progressCallback(chunk.length, totalBytes);
      });
    }
  });

  return promise;
}

function extractTarXz(filePath, outputDir) {
  return new Promise((resolve, reject) => {
    console.log(`Extracting XZ archive: ${filePath}`);

    // Check if xz is available
    console.log('Using native xz and tar with piping');
    const xz = spawn('xz', ['-dc', filePath]);
    // Only extract bin directory to save space, exclude man pages and other unnecessary files
    const fileName = path.basename(filePath);
    const dirName = fileName.replace('.tar.xz', '');
    const tar = spawn('tar', ['-xf', '-', '-C', outputDir, '--strip-components=1', `${dirName}/bin/ffmpeg`]);

    xz.stdout.pipe(tar.stdin);

    xz.stdout.on('data', (data) => {
      console.log(`xz stdout: ${data}`);
    });

    xz.stderr.on('data', (data) => {
      console.error(`xz stderr: ${data}`);
    });

    tar.stdout.on('data', (data) => {
      console.log(`tar stdout: ${data}`);
    });

    tar.stderr.on('data', (data) => {
      console.error(`tar stderr: ${data}`);
    });

    tar.on('close', (code) => {
      if (code !== 0) return reject(new Error(`tar process exited with code ${code}`));
      return resolve();
    });

    xz.on('error', reject);
    tar.on('error', reject);
  });
}

// Extract .zip files
function extractZip(filePath, outputDir) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, {lazyEntries: true}, (err, zipfile) => {
      if (err) return reject(err);
      
      zipfile.on('entry', (entry) => {
        const entryPath = entry.fileName.split('/').slice(1).join('/'); // Remove top-level directory
        if (/\/$/.test(entry.fileName)) {
          // Directory entry
          mkdirp.sync(path.join(outputDir, entryPath));
          zipfile.readEntry();
        } else {
          // File entry
          zipfile.openReadStream(entry, (err, readStream) => {
            if (err) return reject(err);
            
            const outputPath = path.join(outputDir, entryPath);
            mkdirp.sync(path.dirname(outputPath));
            
            const writeStream = fs.createWriteStream(outputPath);
            readStream.pipe(writeStream);
            
            writeStream.on('close', () => {
              zipfile.readEntry();
            });
          });
        }
      });
      
      zipfile.on('end', resolve);
      zipfile.on('error', reject);
      zipfile.readEntry();
    });
  });
}

function getProgressIndicator(tool) {
  let progressBar = null;
  
  return (deltaBytes, totalBytes) => {
    if (progressBar == null) {
      progressBar = new ProgressBar(`Downloading ${tool} [:bar] :percent :etas `, {
        complete: "|",
        incomplete: " ",
        width: 20,
        total: totalBytes,
      });
    }
    if(progressBar.total !== totalBytes) {
      progressBar.total = totalBytes;
    }
    progressBar.tick(deltaBytes);
  };
}

// Determine platform and architecture
const arch = process.env.npm_config_arch || os.arch();
const platform = process.env.npm_config_platform || os.platform();

// Create temp directory
const tempDir = path.join(os.tmpdir(), `ffmpeg-static-${Date.now()}`);
const extractDir = path.join(tempDir, 'extracted');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
if (!fs.existsSync(extractDir)) fs.mkdirSync(extractDir, { recursive: true });

// Create base directory for ffmpeg/ffprobe
const binDir = ffmpegPath ? path.dirname(ffmpegPath) : null;
if (binDir && !fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });

// Add this code here:
// Create base directory for ffmpeg/ffprobe if paths are undefined
if (!ffmpegPath) {
  const binDir = path.join(__dirname, 'bin');
  if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
  ffmpegPath = path.join(binDir, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
}

if (!ffprobePath) {
  const binDir = path.join(__dirname, 'bin');
  if (!fs.existsSync(binDir)) fs.mkdirSync(binDir, { recursive: true });
  ffprobePath = path.join(binDir, platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
}

// Define the binary executable names based on platform
const ffmpegExe = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

// Original source configuration
const release = process.env.FFMPEG_BINARY_RELEASE || 'b4.4.0-rc.11';
// releaseName is unused, so we'll remove it
const originalBaseUrl = process.env.FFMPEG_FFPROBE_STATIC_BASE_URL || 'https://github.com/descriptinc/ffmpeg-ffprobe-static/releases/download/';

// Platform-specific naming for original source
const getOriginalPlatformName = () => {
  switch (platform) {
    case 'win32':
      return arch === 'arm64' ? 'win-arm64' : 'win32-x64';
    case 'darwin':
      return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
    case 'linux':
      return arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
    default:
      exitOnError(`Unsupported platform: ${platform}`);
  }
};

// Platform-specific naming for FFmpeg BnqDzj builds
const getFFmpegCustomPlatformName = () => {
  switch (platform) {
    case 'win32':
      return arch === 'arm64' ? 'winarm64' : 'win64';
    case 'linux':
      return arch === 'arm64' ? 'linuxarm64' : 'linux64';
    default:
      exitOnError(`Unsupported platform: ${platform}`);
  }
};

const originalPlatformName = getOriginalPlatformName();

// Configure FFmpeg download based on platform
let ffmpegDownloadUrl;
let ffmpegDownloadPath;
let isCustomFFmpeg = false;

if (platform === 'darwin') {
  // Use original source for macOS
  ffmpegDownloadUrl = `${originalBaseUrl}${release}/ffmpeg-${originalPlatformName}`;
  ffmpegDownloadPath = ffmpegPath;
  console.log(`[ffmpeg-static] Platform: ${platform}, Architecture: ${arch} - Using original source`);
} else {
  // Use BnqDzj source for Windows and Linux
  isCustomFFmpeg = true;
  const ffmpegBaseUrl = 'https://github.com/BnqDzj/FFmpeg-Builds-nonfree/releases/download/latest';
  const ffmpegPlatformName = getFFmpegCustomPlatformName();
  const ffmpegFileExtension = platform === 'win32' ? 'zip' : 'tar.xz';
  const ffmpegFileName = `ffmpeg-master-latest-${ffmpegPlatformName}-nonfree.${ffmpegFileExtension}`;
  ffmpegDownloadUrl = `${ffmpegBaseUrl}/${ffmpegFileName}`;
  ffmpegDownloadPath = path.join(tempDir, ffmpegFileName);
  console.log(`[ffmpeg-static] Platform: ${platform}, Architecture: ${arch} - Using BnqDzj source`);
}

console.log(`[ffmpeg-static] Downloading FFmpeg from: ${ffmpegDownloadUrl}`);

// Configure FFprobe download (always from original source)
const ffprobeDownloadUrl = `${originalBaseUrl}${release}/ffprobe-${originalPlatformName}`;
console.log(`[ffprobe-static] Downloading FFprobe from: ${ffprobeDownloadUrl}`);

// Download and install FFmpeg
let ffmpegPromise;

if (isCustomFFmpeg) {
  // For Windows/Linux: Download, extract, and copy FFmpeg from BnqDzj
  ffmpegPromise = downloadFile(ffmpegDownloadUrl, ffmpegDownloadPath, getProgressIndicator('ffmpeg'))
    .then(() => {
      console.log(`FFmpeg download complete. Extracting...`);
      const fileExtension = platform === 'win32' ? 'zip' : 'tar.xz';
      if (fileExtension === 'zip') {
        return extractZip(ffmpegDownloadPath, extractDir);
      } else {
        return extractTarXz(ffmpegDownloadPath, extractDir);
      }
    })
    .then(() => {
      console.log('FFmpeg extraction complete. Copying binary...');
      
      // Find the bin directory in extracted files
      const binPath = path.join(extractDir, 'bin');
      
      // Copy ffmpeg to destination
      fs.copyFileSync(path.join(binPath, ffmpegExe), ffmpegPath);
      
      // Make executable on Unix systems
      if (platform !== 'win32') {
        fs.chmodSync(ffmpegPath, 0o755);
      }
      
      console.log(`Successfully installed ffmpeg to ${ffmpegPath}`);
    });
} else {
  // For macOS: Download FFmpeg directly from original source
  ffmpegPromise = downloadFile(ffmpegDownloadUrl, ffmpegDownloadPath, getProgressIndicator('ffmpeg'))
    .then(() => {
      // Make executable on Unix systems
      if (platform !== 'win32') {
        fs.chmodSync(ffmpegPath, 0o755);
      }
      console.log(`Successfully installed ffmpeg to ${ffmpegPath}`);
      
      // Try to download README and LICENSE for ffmpeg
      const ffmpegReadmeUrl = `${originalBaseUrl}${release}/${originalPlatformName}.README`;
      const ffmpegLicenseUrl = `${originalBaseUrl}${release}/${originalPlatformName}.LICENSE`;
      
      return Promise.all([
        downloadFile(ffmpegReadmeUrl, `${ffmpegPath}.README`).catch(warnWith('Failed to download the ffmpeg README.')),
        downloadFile(ffmpegLicenseUrl, `${ffmpegPath}.LICENSE`).catch(warnWith('Failed to download the ffmpeg LICENSE.'))
      ]);
    });
}

// Handle FFmpeg installation errors
ffmpegPromise.catch(err => {
  console.error('FFmpeg installation failed:', err);
  process.exit(1);
});

// Download and install FFprobe (always from original source)
ffmpegPromise
  .then(() => downloadFile(ffprobeDownloadUrl, ffprobePath, getProgressIndicator('ffprobe')))
  .then(() => {
    // Make executable on Unix systems
    if (platform !== 'win32') {
      fs.chmodSync(ffprobePath, 0o755);
    }
    console.log(`Successfully installed ffprobe to ${ffprobePath}`);
    
    // Download README and LICENSE for ffprobe
    const ffprobeReadmeUrl = `${originalBaseUrl}${release}/${originalPlatformName}.README`;
    const ffprobeLicenseUrl = `${originalBaseUrl}${release}/${originalPlatformName}.LICENSE`;
    
    console.log('Downloading additional documentation...');
    return Promise.all([
      downloadFile(ffprobeReadmeUrl, `${ffprobePath}.README`).catch(warnWith('Failed to download the ffprobe README.')),
      downloadFile(ffprobeLicenseUrl, `${ffprobePath}.LICENSE`).catch(warnWith('Failed to download the ffprobe LICENSE.'))
    ]);
  })
  .then(() => {
    // Clean up temp files
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (err) {
      console.warn('Warning: Failed to clean up temporary files', err);
    }
    console.log('Installation complete!');
  })
  .catch(err => {
    console.error('FFprobe installation failed:', err);
    process.exit(1);
  });