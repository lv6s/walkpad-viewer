/* 构建：单个 IIFE bundle。
   这个工具是双击 index.html 用 file:// 打开的 ——    浏览器不允许 file:// 下的 ES module /
   Worker 走 CORS，所以页面用经典脚本，分析 Worker 内联。
   两个页面（主查看器 / 独立轴向页）共用同一份 bundle，由 body[data-page] 分派。 */

import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname, join} from 'node:path';
import {gzipSync} from 'node:zlib';
import {defineConfig} from 'vite';

const vision = dirname(createRequire(import.meta.url).resolve('@mediapipe/tasks-vision'));
const poseModel = new URL('./vendor/pose_landmarker_lite.task', import.meta.url);
const poseRuntime = () => `globalThis.walkpadPoseAssets=${JSON.stringify([
  join(vision,'wasm/vision_wasm_internal.js'), join(vision,'wasm/vision_wasm_internal.wasm'), poseModel,
].map(x => gzipSync(readFileSync(x), {level: 9}).toString('base64')))};`;

export default defineConfig({
  plugins: [{
    name: 'offline-pose-runtime',
    configureServer(server) {
      server.middlewares.use('/dist/pose-runtime.js', (_req, res) => {
        res.setHeader('Content-Type', 'application/javascript');
        res.end(poseRuntime());
      });
    },
    generateBundle() {
      this.emitFile({type: 'asset', fileName: 'pose-runtime.js', source: poseRuntime()});
    },
  }],
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    // 不压缩：产物要能现场排查，而本地打开不在乎这 200 KB
    minify: false,
    lib: {
      entry: 'src/main.ts',
      name: 'WalkpadViewer',
      formats: ['iife'],
      fileName: () => 'app.js'
    }
  }
});
