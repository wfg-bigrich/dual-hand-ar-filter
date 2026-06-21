import {
  buildPanels,
  clamp,
  panelToCanvasPoints,
  shouldRunAtInterval,
  smoothHands,
  sortHandsByScreenX,
} from './geometry.js';

const video = document.querySelector('#cameraVideo');
const canvas = document.querySelector('#arCanvas');
const ctx = canvas.getContext('2d', { alpha: false });
const statusEl = document.querySelector('#status');
const controlsEl = document.querySelector('#controls');
const startButton = document.querySelector('#startButton');
const demoButton = document.querySelector('#demoButton');
const resetButton = document.querySelector('#resetButton');
const smoothSlider = document.querySelector('#smoothSlider');

const sourceCanvas = document.createElement('canvas');
const sourceCtx = sourceCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
const processCanvas = document.createElement('canvas');
const processCtx = processCanvas.getContext('2d', { alpha: false });
const maskCanvas = document.createElement('canvas');
const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
const reducedSourceCanvas = document.createElement('canvas');
const reducedSourceCtx = reducedSourceCanvas.getContext('2d', { alpha: false, willReadFrequently: true });
const reducedMaskCanvas = document.createElement('canvas');
const reducedMaskCtx = reducedMaskCanvas.getContext('2d', { willReadFrequently: true });
const filterCanvases = {
  red: document.createElement('canvas'),
  blue: document.createElement('canvas'),
  green: document.createElement('canvas'),
};
const filterContexts = Object.fromEntries(
  Object.entries(filterCanvases).map(([key, value]) => [
    key,
    value.getContext('2d', { willReadFrequently: true }),
  ]),
);

const MEDIAPIPE_SCRIPTS = [
  'https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js',
  'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_segmentation.js',
];

const HAND_INFERENCE_INTERVAL_MS = 42;
const SEGMENTATION_INTERVAL_MS = 120;
const FILTER_TEXTURE_INTERVAL_MS = 66;
const MAX_PROCESS_WIDTH = 720;
const MAX_TEXTURE_WIDTH = 640;
const MIN_PROCESS_WIDTH = 360;
const MIN_TEXTURE_WIDTH = 340;

const state = {
  mode: 'idle',
  mediaStream: null,
  hands: null,
  segmenter: null,
  modelsReady: false,
  modelLoadPromise: null,
  inferenceBusy: false,
  lastHandsInferenceAt: 0,
  lastSegmentationAt: 0,
  smoothedHands: null,
  latestRawHands: [],
  latestMask: null,
  latestMaskVersion: 0,
  renderedMaskVersion: -1,
  renderedMaskWidth: 0,
  renderedMaskHeight: 0,
  lastFrameTime: 0,
  demoStart: performance.now(),
  demoHands: null,
  lastOneHandMessage: 0,
  textureSeed: 0,
  lastFilterTextureAt: 0,
  filterTextureDirty: true,
  filterTextureWidth: 0,
  filterTextureHeight: 0,
  filterImageData: null,
  needsResize: true,
  statusMessage: '',
  statusError: false,
  statusHidden: false,
};

startButton.addEventListener('click', startCamera);
demoButton.addEventListener('click', startDemo);
resetButton.addEventListener('click', resetExperience);
window.addEventListener('resize', () => {
  state.needsResize = true;
});

applyPendingResize();
setStatus('请点击“演示模式”检查效果，或通过 localhost 启动摄像头');
registerServiceWorker();
requestAnimationFrame(render);

async function startCamera() {
  clearError();

  if (window.location.protocol === 'file:') {
    setError('不能通过 file:// 打开页面调用摄像头，请双击“启动AR.bat”并使用 localhost。');
    return;
  }

  if (!isSecureCameraContext()) {
    setError(getMobileBrowserHint('手机和远程电脑访问摄像头必须使用 HTTPS；本机调试请使用 localhost。'));
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setError(getMobileBrowserHint('当前浏览器不支持摄像头访问，请使用 Safari、Chrome、Edge 或三星浏览器打开 HTTPS 地址。'));
    return;
  }

  startButton.disabled = true;
  setStatus('正在加载 MediaPipe 模型...');

  try {
    await ensureMediaPipe();
    await openCameraStream();

    state.mode = 'camera';
    state.smoothedHands = null;
    state.latestRawHands = [];
    state.demoHands = null;
    resetRealtimeCaches({ clearMask: true });
    document.body.classList.add('is-live');
    setStatus('请伸开左右两只手，让四个指尖进入画面');
  } catch (error) {
    stopCameraStream();
    setError(cameraErrorMessage(error));
  } finally {
    startButton.disabled = false;
  }
}

function startDemo() {
  clearError();
  stopCameraStream();
  state.mode = 'demo';
  state.demoStart = performance.now();
  state.smoothedHands = null;
  state.latestRawHands = [];
  resetRealtimeCaches({ clearMask: true });
  document.body.classList.remove('is-live');
  setStatus('演示模式：三块滤镜面片正在自动变形');
}

function resetExperience() {
  state.smoothedHands = null;
  state.demoHands = null;
  state.latestRawHands = [];
  resetRealtimeCaches({ clearMask: true });
  state.lastOneHandMessage = 0;
  state.demoStart = performance.now();

  if (state.mode === 'camera') {
    setStatus('已重置，请重新伸开左右两只手');
  } else if (state.mode === 'demo') {
    setStatus('演示已重置');
  } else {
    setStatus('已重置');
  }
}

function resetRealtimeCaches({ clearMask = false } = {}) {
  state.inferenceBusy = false;
  state.lastHandsInferenceAt = 0;
  state.lastSegmentationAt = 0;
  state.lastFilterTextureAt = 0;
  state.filterTextureDirty = true;
  state.filterImageData = null;
  state.renderedMaskVersion = -1;
  state.renderedMaskWidth = 0;
  state.renderedMaskHeight = 0;

  if (clearMask) {
    state.latestMask = null;
    state.latestMaskVersion += 1;
  }
}

async function ensureMediaPipe() {
  if (state.modelsReady) {
    return;
  }

  if (!state.modelLoadPromise) {
    state.modelLoadPromise = loadMediaPipe().catch((error) => {
      state.modelLoadPromise = null;
      throw error;
    });
  }

  await state.modelLoadPromise;
}

async function loadMediaPipe() {
  try {
    for (const src of MEDIAPIPE_SCRIPTS) {
      await loadScript(src);
    }

    if (!window.Hands || !window.SelfieSegmentation) {
      throw new Error('MediaPipe globals missing');
    }

    state.hands = new window.Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
    });
    state.hands.setOptions({
      maxNumHands: 2,
      modelComplexity: 1,
      minDetectionConfidence: 0.68,
      minTrackingConfidence: 0.58,
    });
    state.hands.onResults(handleHandsResults);

    state.segmenter = new window.SelfieSegmentation({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`,
    });
    state.segmenter.setOptions({
      modelSelection: 1,
    });
    state.segmenter.onResults(handleSegmentationResults);

    if (typeof state.hands.initialize === 'function') {
      await state.hands.initialize();
    }
    if (typeof state.segmenter.initialize === 'function') {
      await state.segmenter.initialize();
    }

    state.modelsReady = true;
  } catch (error) {
    throw new Error('MEDIAPIPE_LOAD_FAILED', { cause: error });
  }
}

function loadScript(src) {
  const existing = document.querySelector(`script[data-mediapipe-src="${src}"]`);
  if (existing?.dataset.loaded === 'true') {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const script = existing || document.createElement('script');
    script.src = src;
    script.async = true;
    script.defer = true;
    script.dataset.mediapipeSrc = src;
    script.onload = () => {
      script.dataset.loaded = 'true';
      resolve();
    };
    script.onerror = () => reject(new Error(`Failed to load ${src}`));

    if (!existing) {
      document.head.appendChild(script);
    }
  });
}

async function openCameraStream() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: 'user',
    },
  });

  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  state.mediaStream = stream;
}

function stopCameraStream() {
  if (state.mediaStream) {
    state.mediaStream.getTracks().forEach((track) => track.stop());
  }

  state.mediaStream = null;
  video.srcObject = null;
  document.body.classList.remove('is-live');
}

function render(timestamp) {
  applyPendingResize();
  state.lastFrameTime = timestamp;

  if (state.mode === 'camera' && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    drawMirroredCover(sourceCtx, video, video.videoWidth, video.videoHeight, sourceCanvas.width, sourceCanvas.height);
    maybeRunInference(timestamp);
    drawSceneFromSource(timestamp);
    renderCameraPanels(timestamp);
  } else if (state.mode === 'demo') {
    drawDemoSource(timestamp);
    drawSceneFromSource(timestamp);
    renderDemoPanels(timestamp);
  } else {
    drawIdleScene(timestamp);
  }

  requestAnimationFrame(render);
}

function renderCameraPanels(timestamp) {
  updateMaskFromSegmentation();

  const sortedHands = sortHandsByScreenX(state.latestRawHands);

  if (sortedHands.length === 1) {
    showOneHandMessage(timestamp);
    return;
  }

  if (sortedHands.length < 2) {
    state.smoothedHands = null;
    setStatus('请伸开左右两只手，让四个指尖进入画面');
    return;
  }

  state.smoothedHands = smoothHands(state.smoothedHands, sortedHands, currentFollowAmount());
  setStatus('', true);
  updateFilterTextures(timestamp);
  drawPanels(state.smoothedHands, timestamp);
}

function renderDemoPanels(timestamp) {
  const demoHands = createDemoHands((timestamp - state.demoStart) / 1000);
  state.demoHands = smoothHands(state.demoHands, demoHands, currentFollowAmount());
  drawDemoMask(timestamp);
  updateFilterTextures(timestamp);
  drawPanels(state.demoHands, timestamp);
}

function drawSceneFromSource(timestamp) {
  ctx.drawImage(sourceCanvas, 0, 0, canvas.width, canvas.height);
  addCameraGrain(ctx, canvas.width, canvas.height, timestamp, 0.08);
}

function drawIdleScene(timestamp) {
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  const gradient = ctx.createRadialGradient(width * 0.5, height * 0.42, 0, width * 0.5, height * 0.42, Math.max(width, height) * 0.7);
  gradient.addColorStop(0, '#181a20');
  gradient.addColorStop(0.48, '#090b10');
  gradient.addColorStop(1, '#040509');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  addCameraGrain(ctx, width, height, timestamp, 0.1);
}

function drawDemoSource(timestamp) {
  const width = sourceCanvas.width;
  const height = sourceCanvas.height;
  const time = (timestamp - state.demoStart) / 1000;

  sourceCtx.clearRect(0, 0, width, height);
  const background = sourceCtx.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, '#11151b');
  background.addColorStop(0.48, '#20242a');
  background.addColorStop(1, '#07080c');
  sourceCtx.fillStyle = background;
  sourceCtx.fillRect(0, 0, width, height);

  sourceCtx.save();
  sourceCtx.globalAlpha = 0.24;
  sourceCtx.strokeStyle = '#f7e6bf';
  sourceCtx.lineWidth = Math.max(1, width * 0.0012);
  const spacing = Math.max(32, width * 0.045);
  for (let x = -spacing; x < width + spacing; x += spacing) {
    sourceCtx.beginPath();
    sourceCtx.moveTo(x + Math.sin(time + x * 0.01) * 9, 0);
    sourceCtx.lineTo(x - width * 0.1, height);
    sourceCtx.stroke();
  }
  sourceCtx.restore();

  drawDemoPerson(sourceCtx, width, height, time);
  addCameraGrain(sourceCtx, width, height, timestamp, 0.14);
}

function drawDemoPerson(targetCtx, width, height, time) {
  const centerX = width * (0.5 + Math.sin(time * 0.7) * 0.015);
  const centerY = height * 0.53;

  targetCtx.save();
  targetCtx.shadowColor = 'rgba(0, 0, 0, 0.5)';
  targetCtx.shadowBlur = width * 0.025;
  targetCtx.fillStyle = '#d4c5a4';
  targetCtx.beginPath();
  targetCtx.ellipse(centerX, height * 0.31, width * 0.06, height * 0.088, 0, 0, Math.PI * 2);
  targetCtx.fill();

  targetCtx.fillStyle = '#947f66';
  targetCtx.beginPath();
  targetCtx.ellipse(centerX, centerY, width * 0.145, height * 0.23, 0, 0, Math.PI * 2);
  targetCtx.fill();

  targetCtx.strokeStyle = '#c9b18d';
  targetCtx.lineWidth = Math.max(18, width * 0.035);
  targetCtx.lineCap = 'round';
  targetCtx.beginPath();
  targetCtx.moveTo(centerX - width * 0.1, height * 0.46);
  targetCtx.bezierCurveTo(width * 0.35, height * 0.43, width * 0.28, height * 0.55, width * 0.22, height * 0.61);
  targetCtx.moveTo(centerX + width * 0.1, height * 0.46);
  targetCtx.bezierCurveTo(width * 0.65, height * 0.41, width * 0.73, height * 0.54, width * 0.8, height * 0.59);
  targetCtx.stroke();
  targetCtx.restore();
}

function drawDemoMask(timestamp) {
  const width = maskCanvas.width;
  const height = maskCanvas.height;
  const time = (timestamp - state.demoStart) / 1000;
  const centerX = width * (0.5 + Math.sin(time * 0.7) * 0.015);

  maskCtx.clearRect(0, 0, width, height);
  maskCtx.save();
  maskCtx.filter = `blur(${Math.max(10, width * 0.012)}px)`;
  maskCtx.fillStyle = '#fff';
  maskCtx.beginPath();
  maskCtx.ellipse(centerX, height * 0.53, width * 0.18, height * 0.27, 0, 0, Math.PI * 2);
  maskCtx.fill();
  maskCtx.beginPath();
  maskCtx.ellipse(centerX, height * 0.31, width * 0.08, height * 0.11, 0, 0, Math.PI * 2);
  maskCtx.fill();
  maskCtx.lineCap = 'round';
  maskCtx.lineWidth = Math.max(34, width * 0.052);
  maskCtx.strokeStyle = '#fff';
  maskCtx.beginPath();
  maskCtx.moveTo(centerX - width * 0.11, height * 0.46);
  maskCtx.bezierCurveTo(width * 0.35, height * 0.43, width * 0.28, height * 0.55, width * 0.22, height * 0.61);
  maskCtx.moveTo(centerX + width * 0.11, height * 0.46);
  maskCtx.bezierCurveTo(width * 0.65, height * 0.41, width * 0.73, height * 0.54, width * 0.8, height * 0.59);
  maskCtx.stroke();
  maskCtx.restore();
}

function createDemoHands(time) {
  const leftPalm = {
    x: 0.225 + Math.sin(time * 0.9) * 0.018,
    y: 0.565 + Math.cos(time * 1.2) * 0.025,
  };
  const rightPalm = {
    x: 0.775 + Math.sin(time * 0.82 + 1.4) * 0.018,
    y: 0.555 + Math.cos(time * 1.1 + 0.7) * 0.025,
  };

  return [
    createDemoHand(leftPalm, 1, time),
    createDemoHand(rightPalm, -1, time + 0.8),
  ];
}

function createDemoHand(palm, direction, time) {
  const hand = Array.from({ length: 21 }, (_, index) => ({
    x: palm.x + direction * (0.012 + (index % 4) * 0.003),
    y: palm.y + (index % 5) * 0.004,
    z: 0,
  }));

  const wave = Math.sin(time * 1.55);
  const fingerSpread = [
    { id: 4, x: 0.04, y: -0.18 },
    { id: 8, x: 0.02, y: -0.08 },
    { id: 12, x: 0.01, y: 0.03 },
    { id: 20, x: -0.005, y: 0.16 },
  ];

  for (const finger of fingerSpread) {
    hand[finger.id] = {
      x: palm.x + direction * (finger.x + Math.sin(time * 1.7 + finger.id) * 0.016),
      y: palm.y + finger.y + wave * 0.012 + Math.cos(time * 1.3 + finger.id) * 0.012,
      z: 0,
    };
  }

  hand[0] = { x: palm.x, y: palm.y + 0.02, z: 0 };
  hand[5] = { x: palm.x + direction * 0.015, y: palm.y - 0.035, z: 0 };
  hand[9] = { x: palm.x + direction * 0.006, y: palm.y + 0.02, z: 0 };
  hand[17] = { x: palm.x - direction * 0.008, y: palm.y + 0.09, z: 0 };

  return hand;
}

function drawPanels(hands, timestamp) {
  const panels = buildPanels(hands);
  if (panels.length !== 3) {
    return;
  }

  for (const panel of panels) {
    const points = panelToCanvasPoints(panel, canvas.width, canvas.height);
    drawFilteredPanel(panel.kind, points, timestamp);
    drawPanelChrome(panel.kind, points, timestamp);
  }
}

function drawFilteredPanel(kind, points, timestamp) {
  const texture = filterCanvases[kind];

  if (!texture.width || !texture.height) {
    return;
  }

  ctx.save();
  traceQuad(ctx, points);
  ctx.clip();
  ctx.globalAlpha = 0.96;
  ctx.drawImage(texture, 0, 0, canvas.width, canvas.height);

  ctx.globalCompositeOperation = 'screen';
  ctx.globalAlpha = kind === 'red' ? 0.1 : 0.08;
  ctx.fillStyle = panelAccent(kind);
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 0.18 + Math.sin(timestamp * 0.004) * 0.04;
  ctx.fillStyle = makePanelSheen(points);
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
}

function drawPanelChrome(kind, points, timestamp) {
  const color = panelAccent(kind);

  ctx.save();
  ctx.globalAlpha = 0.82;
  ctx.lineWidth = Math.max(1.4, canvas.width * 0.0015);
  ctx.strokeStyle = color;
  traceQuad(ctx, points);
  ctx.stroke();

  ctx.globalAlpha = 0.18;
  ctx.lineWidth = Math.max(7, canvas.width * 0.007);
  traceQuad(ctx, points);
  ctx.stroke();

  const pulse = 2 + Math.sin(timestamp * 0.006) * 1.2;
  ctx.globalAlpha = 0.86;
  ctx.fillStyle = '#f8edcf';
  for (const point of points) {
    ctx.beginPath();
    ctx.arc(point.x, point.y, Math.max(2.2, canvas.width * 0.0024) + pulse * 0.15, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function makePanelSheen(points) {
  const left = (points[0].x + points[3].x) * 0.5;
  const right = (points[1].x + points[2].x) * 0.5;
  const top = (points[0].y + points[1].y) * 0.5;
  const bottom = (points[2].y + points[3].y) * 0.5;
  const gradient = ctx.createLinearGradient(left, top, right, bottom);
  gradient.addColorStop(0, 'rgba(255,255,255,0)');
  gradient.addColorStop(0.5, 'rgba(255,255,255,0.28)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  return gradient;
}

function traceQuad(targetCtx, points) {
  targetCtx.beginPath();
  targetCtx.moveTo(points[0].x, points[0].y);
  targetCtx.lineTo(points[1].x, points[1].y);
  targetCtx.lineTo(points[2].x, points[2].y);
  targetCtx.lineTo(points[3].x, points[3].y);
  targetCtx.closePath();
}

function maybeRunInference(timestamp) {
  if (!state.modelsReady || state.inferenceBusy || state.mode !== 'camera') {
    return;
  }

  if (!shouldRunAtInterval(state.lastHandsInferenceAt, timestamp, HAND_INFERENCE_INTERVAL_MS)) {
    return;
  }

  const width = Math.min(MAX_PROCESS_WIDTH, Math.max(MIN_PROCESS_WIDTH, Math.round(window.innerWidth * 0.68)));
  const height = Math.round(width * (canvas.height / Math.max(1, canvas.width)));
  const shouldSegment = !state.latestMask || shouldRunAtInterval(state.lastSegmentationAt, timestamp, SEGMENTATION_INTERVAL_MS);

  if (processCanvas.width !== width || processCanvas.height !== height) {
    processCanvas.width = width;
    processCanvas.height = height;
  }

  drawMirroredCover(processCtx, video, video.videoWidth, video.videoHeight, width, height);
  state.inferenceBusy = true;
  state.lastHandsInferenceAt = timestamp;

  Promise.resolve()
    .then(() => state.hands.send({ image: processCanvas }))
    .then(() => {
      if (!shouldSegment) {
        return null;
      }

      state.lastSegmentationAt = timestamp;
      return state.segmenter.send({ image: processCanvas });
    })
    .catch((error) => {
      console.error(error);
      setError('MediaPipe 模型加载失败，请检查网络连接后刷新页面。');
    })
    .finally(() => {
      state.inferenceBusy = false;
    });
}

function handleHandsResults(results) {
  state.latestRawHands = results.multiHandLandmarks || [];
}

function handleSegmentationResults(results) {
  state.latestMask = results.segmentationMask || null;
  state.latestMaskVersion += 1;
}

function updateMaskFromSegmentation() {
  const maskIsCurrent =
    state.renderedMaskVersion === state.latestMaskVersion
    && state.renderedMaskWidth === maskCanvas.width
    && state.renderedMaskHeight === maskCanvas.height;

  if (maskIsCurrent) {
    return;
  }

  maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);

  if (!state.latestMask) {
    state.renderedMaskVersion = state.latestMaskVersion;
    state.renderedMaskWidth = maskCanvas.width;
    state.renderedMaskHeight = maskCanvas.height;
    return;
  }

  const blur = Math.max(8, canvas.width * 0.008);
  maskCtx.save();
  maskCtx.filter = `blur(${blur}px)`;
  maskCtx.globalAlpha = 0.9;
  maskCtx.drawImage(state.latestMask, -blur, -blur, maskCanvas.width + blur * 2, maskCanvas.height + blur * 2);
  maskCtx.restore();

  maskCtx.save();
  maskCtx.globalAlpha = 0.42;
  maskCtx.drawImage(state.latestMask, 0, 0, maskCanvas.width, maskCanvas.height);
  maskCtx.restore();

  state.renderedMaskVersion = state.latestMaskVersion;
  state.renderedMaskWidth = maskCanvas.width;
  state.renderedMaskHeight = maskCanvas.height;
}

function updateFilterTextures(timestamp) {
  const maxTextureWidth = Math.min(MAX_TEXTURE_WIDTH, Math.max(MIN_TEXTURE_WIDTH, Math.round(window.innerWidth * 0.58)));
  const textureWidth = Math.round(maxTextureWidth);
  const textureHeight = Math.max(1, Math.round(textureWidth * (canvas.height / Math.max(1, canvas.width))));
  const sizeChanged = textureWidth !== state.filterTextureWidth || textureHeight !== state.filterTextureHeight;

  if (
    !state.filterTextureDirty
    && !sizeChanged
    && !shouldRunAtInterval(state.lastFilterTextureAt, timestamp, FILTER_TEXTURE_INTERVAL_MS)
  ) {
    return;
  }

  setCanvasSize(reducedSourceCanvas, textureWidth, textureHeight);
  setCanvasSize(reducedMaskCanvas, textureWidth, textureHeight);

  reducedSourceCtx.drawImage(sourceCanvas, 0, 0, textureWidth, textureHeight);
  reducedMaskCtx.clearRect(0, 0, textureWidth, textureHeight);
  reducedMaskCtx.drawImage(maskCanvas, 0, 0, textureWidth, textureHeight);

  const sourceData = reducedSourceCtx.getImageData(0, 0, textureWidth, textureHeight);
  const maskData = reducedMaskCtx.getImageData(0, 0, textureWidth, textureHeight);
  const filterImageData = getReusableFilterImageData(textureWidth, textureHeight);
  const redImage = filterImageData.red;
  const blueImage = filterImageData.blue;
  const greenImage = filterImageData.green;
  const seed = Math.floor(timestamp * 0.02) + state.textureSeed;

  for (let y = 0; y < textureHeight; y += 1) {
    for (let x = 0; x < textureWidth; x += 1) {
      const index = (y * textureWidth + x) * 4;
      const red = sourceData.data[index];
      const green = sourceData.data[index + 1];
      const blue = sourceData.data[index + 2];
      const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
      const maskStrength = maskAmount(maskData.data, index);
      const grain = noise2d(x, y, seed) - 0.5;

      writeRedHalftone(redImage.data, index, x, y, luminance, grain, maskStrength);
      writeBlueThermal(blueImage.data, index, x, y, luminance, grain, maskStrength);
      writeGreenPseudo(greenImage.data, index, x, y, sourceData.data, textureWidth, textureHeight, luminance, grain, maskStrength);
    }
  }

  putFilterImage('red', redImage, textureWidth, textureHeight);
  putFilterImage('blue', blueImage, textureWidth, textureHeight);
  putFilterImage('green', greenImage, textureWidth, textureHeight);

  state.lastFilterTextureAt = timestamp;
  state.filterTextureDirty = false;
  state.filterTextureWidth = textureWidth;
  state.filterTextureHeight = textureHeight;
}

function putFilterImage(kind, imageData, width, height) {
  const filterCanvas = filterCanvases[kind];
  const filterCtx = filterContexts[kind];
  setCanvasSize(filterCanvas, width, height);
  filterCtx.putImageData(imageData, 0, 0);
}

function getReusableFilterImageData(width, height) {
  if (
    !state.filterImageData
    || state.filterTextureWidth !== width
    || state.filterTextureHeight !== height
  ) {
    state.filterImageData = {
      red: filterContexts.red.createImageData(width, height),
      blue: filterContexts.blue.createImageData(width, height),
      green: filterContexts.green.createImageData(width, height),
    };
  }

  return state.filterImageData;
}

function writeRedHalftone(data, index, x, y, luminance, grain, maskStrength) {
  const cell = 7;
  const localX = (x % cell) - cell / 2;
  const localY = (y % cell) - cell / 2;
  const radius = (1 - luminance / 255) * cell * 0.58 + grain * 1.1;
  const dot = Math.hypot(localX, localY) < radius;
  const ink = luminance < 70 || (dot && luminance < 150);
  const color = ink
    ? mixColor([26, 20, 18], [184, 36, 30], clamp((luminance - 35) / 120, 0, 1))
    : mixColor([232, 218, 190], [198, 54, 42], clamp((150 - luminance) / 170, 0, 0.32));

  data[index] = clamp(color[0] + grain * 22, 0, 255);
  data[index + 1] = clamp(color[1] + grain * 14, 0, 255);
  data[index + 2] = clamp(color[2] + grain * 9, 0, 255);
  data[index + 3] = Math.round(maskStrength * 244);
}

function writeBlueThermal(data, index, x, y, luminance, grain, maskStrength) {
  const scan = (Math.sin(y * 0.62) + 1) * 0.5;
  const heat = clamp((luminance - 42) / 178, 0, 1);
  const base = heat < 0.55
    ? mixColor([13, 27, 56], [24, 116, 142], heat / 0.55)
    : mixColor([24, 116, 142], [210, 219, 215], (heat - 0.55) / 0.45);

  data[index] = clamp(base[0] + scan * 9 + grain * 13, 0, 255);
  data[index + 1] = clamp(base[1] + scan * 12 + grain * 11, 0, 255);
  data[index + 2] = clamp(base[2] + scan * 15 + grain * 9, 0, 255);
  data[index + 3] = Math.round(maskStrength * 236);
}

function writeGreenPseudo(data, index, x, y, source, width, height, luminance, grain, maskStrength) {
  const ghostX = clamp(Math.round(x - 4), 0, width - 1);
  const ghostY = clamp(Math.round(y + Math.sin(x * 0.05) * 2), 0, height - 1);
  const ghostIndex = (ghostY * width + ghostX) * 4;
  const ghostLuma = source[ghostIndex] * 0.2126 + source[ghostIndex + 1] * 0.7152 + source[ghostIndex + 2] * 0.0722;
  const tone = clamp((luminance * 0.82 + ghostLuma * 0.18 - 26) / 210, 0, 1);
  const base = tone < 0.52
    ? mixColor([20, 55, 43], [85, 118, 86], tone / 0.52)
    : mixColor([85, 118, 86], [228, 216, 184], (tone - 0.52) / 0.48);
  const paper = ((x + y) % 5 === 0 ? 10 : 0) + grain * 18;

  data[index] = clamp(base[0] + paper, 0, 255);
  data[index + 1] = clamp(base[1] + paper * 0.9, 0, 255);
  data[index + 2] = clamp(base[2] + paper * 0.65, 0, 255);
  data[index + 3] = Math.round(maskStrength * 238);
}

function maskAmount(maskData, index) {
  const alpha = maskData[index + 3] / 255;
  const luminance = (maskData[index] + maskData[index + 1] + maskData[index + 2]) / (255 * 3);
  return clamp(alpha < 0.98 ? Math.max(alpha, luminance) : luminance, 0, 1);
}

function panelAccent(kind) {
  if (kind === 'red') {
    return '#e24a36';
  }
  if (kind === 'blue') {
    return '#4eb8cf';
  }
  return '#83b36b';
}

function mixColor(a, b, amount) {
  const t = clamp(amount, 0, 1);
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function noise2d(x, y, seed) {
  const value = Math.sin(x * 12.9898 + y * 78.233 + seed * 37.719) * 43758.5453;
  return value - Math.floor(value);
}

function addCameraGrain(targetCtx, width, height, timestamp, strength) {
  const step = Math.max(18, Math.round(width / 70));
  targetCtx.save();
  targetCtx.globalAlpha = strength;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const value = Math.floor(noise2d(x, y, Math.floor(timestamp * 0.02)) * 70);
      targetCtx.fillStyle = `rgb(${value}, ${value}, ${value})`;
      targetCtx.fillRect(x, y, step, step);
    }
  }
  targetCtx.restore();
}

function drawMirroredCover(targetCtx, image, imageWidth, imageHeight, targetWidth, targetHeight) {
  if (!imageWidth || !imageHeight || !targetWidth || !targetHeight) {
    return;
  }

  const sourceRatio = imageWidth / imageHeight;
  const targetRatio = targetWidth / targetHeight;
  let sx = 0;
  let sy = 0;
  let sw = imageWidth;
  let sh = imageHeight;

  if (sourceRatio > targetRatio) {
    sw = imageHeight * targetRatio;
    sx = (imageWidth - sw) * 0.5;
  } else {
    sh = imageWidth / targetRatio;
    sy = (imageHeight - sh) * 0.5;
  }

  targetCtx.save();
  targetCtx.clearRect(0, 0, targetWidth, targetHeight);
  targetCtx.translate(targetWidth, 0);
  targetCtx.scale(-1, 1);
  targetCtx.drawImage(image, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);
  targetCtx.restore();
}

function applyPendingResize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(window.innerWidth * dpr));
  const height = Math.max(1, Math.round(window.innerHeight * dpr));

  if (!state.needsResize && canvas.width === width && canvas.height === height) {
    return false;
  }

  state.needsResize = false;

  const resized = [
    setCanvasSize(canvas, width, height),
    setCanvasSize(sourceCanvas, width, height),
    setCanvasSize(maskCanvas, width, height),
  ].some(Boolean);

  if (resized) {
    markVisualBuffersDirty();
  }

  return resized;
}

function setCanvasSize(targetCanvas, width, height) {
  if (targetCanvas.width !== width || targetCanvas.height !== height) {
    targetCanvas.width = width;
    targetCanvas.height = height;
    return true;
  }

  return false;
}

function markVisualBuffersDirty() {
  state.filterTextureDirty = true;
  state.renderedMaskVersion = -1;
}

function currentFollowAmount() {
  const smoothness = Number(smoothSlider.value) / 100;
  return clamp(1 - smoothness * 0.82, 0.18, 1);
}

function showOneHandMessage(timestamp) {
  state.smoothedHands = null;

  if (timestamp - state.lastOneHandMessage > 500) {
    setError('只识别到一只手，请把另一只手也放入画面。');
    state.lastOneHandMessage = timestamp;
  }
}

function setStatus(message, hidden = false) {
  if (state.statusMessage === message && !state.statusError && state.statusHidden === hidden) {
    return;
  }

  state.statusMessage = message;
  state.statusError = false;
  state.statusHidden = hidden;
  statusEl.textContent = message;
  statusEl.classList.remove('is-error');
  statusEl.classList.toggle('is-hidden', hidden);
}

function setError(message, visible = true) {
  const hidden = !visible;
  if (state.statusMessage === message && state.statusError && state.statusHidden === hidden) {
    return;
  }

  state.statusMessage = message;
  state.statusError = true;
  state.statusHidden = hidden;
  statusEl.textContent = message;
  statusEl.classList.add('is-error');
  statusEl.classList.toggle('is-hidden', hidden);
}

function clearError() {
  state.statusError = false;
  statusEl.classList.remove('is-error');
}

function isSecureCameraContext() {
  return window.isSecureContext || ['localhost', '127.0.0.1', '[::1]', '::1'].includes(window.location.hostname);
}

function getMobileBrowserHint(baseMessage) {
  const userAgent = navigator.userAgent || '';
  const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent);
  const isEmbedded = /MicroMessenger|QQ\/|QQBrowser|DingTalk|Weibo|Bytedance|NewsArticle|aweme|FBAN|FBAV|Instagram|Line\//i.test(userAgent);

  if (isEmbedded) {
    return `${baseMessage} 当前像是在内置浏览器中，请点右上角菜单，选择“在浏览器打开”，再用 Safari、Chrome、Edge 或三星浏览器访问同一个 HTTPS 地址。`;
  }

  if (isMobile) {
    return `${baseMessage} 手机上请直接打开 HTTPS 网址，首次弹出摄像头权限时选择允许。`;
  }

  return baseMessage;
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || window.location.protocol === 'file:') {
    return;
  }

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch((error) => {
      console.info('Service worker registration skipped:', error);
    });
  });
}

function cameraErrorMessage(error) {
  if (error?.message === 'MEDIAPIPE_LOAD_FAILED') {
    return 'MediaPipe 模型加载失败，请检查网络连接后刷新页面。';
  }

  switch (error?.name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return '摄像头权限被拒绝，请在浏览器地址栏允许摄像头后重试。';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return '没有找到摄像头，请连接摄像头后重试。';
    case 'NotReadableError':
    case 'TrackStartError':
      return '摄像头被其他软件占用，请关闭会议软件或相机程序后重试。';
    case 'SecurityError':
      return '浏览器阻止了摄像头访问，请使用 HTTPS 或 localhost 打开页面。';
    default:
      return '摄像头启动失败，请确认权限、设备和浏览器设置后重试。';
  }
}
