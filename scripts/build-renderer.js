'use strict';
/**
 * 极简渲染层构建脚本 (scripts/build-renderer.js)
 * 将 src/renderer/{styles.css, template.html, main.js} 组合输出至根目录 meter-renderer.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const rootDir = path.resolve(__dirname, '..');

function readClean(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n').trim();
}

function buildRenderer(options = {}) {
  const effRootDir = options.rootDir ? path.resolve(options.rootDir) : rootDir;
  const effSrcDir = options.srcDir ? path.resolve(options.srcDir) : path.join(effRootDir, 'src', 'renderer');
  const effTargetFile = options.targetFile ? path.resolve(options.targetFile) : path.join(effRootDir, 'meter-renderer.js');

  const pkg = JSON.parse(fs.readFileSync(path.join(effRootDir, 'package.json'), 'utf8'));
  const meterVersion = pkg.version || '1.0.0';
  const displayVersion = (typeof pkg.displayVersion === 'string' && pkg.displayVersion.trim()) ? pkg.displayVersion.trim() : `v${meterVersion}`;

  const styles = readClean(path.join(effSrcDir, 'styles.css'));
  let template = readClean(path.join(effSrcDir, 'template.html'));
  template = template.replace(/(<span id="ver"[^>]*>)[^<]*(<\/span>)/g, `$1v${displayVersion.replace(/^v/i, '')}$2`);

  let mainSrc = fs.readFileSync(path.join(effSrcDir, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  if (!mainSrc.trim()) throw new Error('Renderer entry point is empty');

  mainSrc = mainSrc
    .replace(/const METER_VERSION = '[^']*';/, `const METER_VERSION = '${meterVersion}';`)
    .replace(/const METER_DISPLAY_VERSION = '[^']*';/, `const METER_DISPLAY_VERSION = '${displayVersion}';`);

  const escTemplate = (s) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\${/g, '\\${');
  const domBlock = `  shadow.innerHTML = \`<style>\n${escTemplate(styles)}\n</style>\n${escTemplate(template)}\`;`;

  let output = mainSrc.replace('  /* @INSERT_STYLES_AND_TEMPLATE */', () => domBlock);
  const buildId = crypto.createHash('sha256').update(output).digest('hex').slice(0, 12);
  output = output.replace('__AG_RENDER_BUILD_ID__', buildId);

  fs.writeFileSync(effTargetFile, output, 'utf8');
  console.log(`[build-renderer] ${effTargetFile} (v${meterVersion}, ${Buffer.byteLength(output, 'utf8')} bytes, build=${buildId})`);
  return { outputPath: effTargetFile, version: meterVersion, buildId };
}

if (require.main === module) {
  buildRenderer();
}

module.exports = { buildRenderer };
