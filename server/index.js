const express = require('express');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const net = require('net');
const axios = require('axios');
const cheerio = require('cheerio');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'services.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DEFAULT_SCAN_RANGE = { start: 3000, end: 3010, host: 'host.docker.internal' };
const MAX_ICON_BYTES = 2 * 1024 * 1024;

const DEFAULT_DATA = {
  services: [],
  lastScan: null,
  scanRange: DEFAULT_SCAN_RANGE
};

const ICON_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/svg': '.svg',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'image/icon': '.ico'
};

const PAGE_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
};

const ICON_HEADERS = {
  Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
  'User-Agent': PAGE_HEADERS['User-Agent']
};

const ORIGIN_ICON_PATHS = [
  '/favicon.ico',
  '/favicon.svg',
  '/favicon.png',
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
  '/apple-touch-icon-180x180.png',
  '/logo.svg',
  '/logo.png',
  '/icon.svg',
  '/icon.png'
];

fs.ensureDirSync(DATA_DIR);
fs.ensureDirSync(UPLOADS_DIR);

const migrateLegacyDataIfNeeded = () => {
  const legacyDir = process.env.LEGACY_DATA_DIR;
  if (!legacyDir) {
    return;
  }

  const currentMissing = !fs.existsSync(DATA_FILE) || fs.readFileSync(DATA_FILE, 'utf8').trim() === '';
  if (!currentMissing) {
    return;
  }

  const legacyFile = path.join(legacyDir, 'services.json');
  if (!fs.existsSync(legacyFile)) {
    return;
  }

  fs.copySync(legacyDir, DATA_DIR, { overwrite: true });
  console.log(`Migrated existing dashboard data from ${legacyDir} into ${DATA_DIR}`);
};

migrateLegacyDataIfNeeded();

if (!fs.existsSync(DATA_FILE) || fs.readFileSync(DATA_FILE, 'utf8').trim() === '') {
  fs.writeJsonSync(DATA_FILE, DEFAULT_DATA, { spaces: 2 });
}

const createIconFileName = (extension) => {
  const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  return `icon-${uniqueSuffix}${extension}`;
};

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, UPLOADS_DIR);
  },
  filename(req, file, cb) {
    const extension = path.extname(file.originalname || '').toLowerCase() || '.png';
    cb(null, createIconFileName(extension));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_ICON_BYTES },
  fileFilter(req, file, cb) {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      cb(new Error('Only image uploads are allowed'));
      return;
    }

    cb(null, true);
  }
});

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR, {
  fallthrough: true,
  index: false,
  maxAge: '7d'
}));

const isLocalIcon = (iconPath) => typeof iconPath === 'string' && iconPath.startsWith('/uploads/');

const getIconExtension = (contentType, sourceUrl) => {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (ICON_EXTENSIONS[type]) {
    return ICON_EXTENSIONS[type];
  }

  try {
    const extension = path.extname(new URL(sourceUrl).pathname).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico'].includes(extension)) {
      return extension === '.jpeg' ? '.jpg' : extension;
    }
  } catch (error) {
    // Ignore invalid URLs and fall back to png.
  }

  return '.png';
};

const sniffImageExtension = (buffer) => {
  if (!buffer || buffer.length < 4) {
    return null;
  }

  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return '.png';
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return '.jpg';
  }

  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return '.gif';
  }

  if (buffer[0] === 0x00 && buffer[1] === 0x00 && (buffer[2] === 0x01 || buffer[2] === 0x02) && buffer[3] === 0x00) {
    return '.ico';
  }

  if (buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.length >= 12 && buffer.slice(8, 12).toString('ascii') === 'WEBP') {
    return '.webp';
  }

  const head = buffer.slice(0, 256).toString('utf8').trim().toLowerCase();
  if (head.includes('<svg')) {
    return '.svg';
  }

  if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
    return null;
  }

  return null;
};

const isProbablyImageBuffer = (buffer, contentType) => {
  if (sniffImageExtension(buffer)) {
    return true;
  }

  const type = String(contentType || '').toLowerCase();
  return type.startsWith('image/') && !type.includes('text/html');
};

const persistIconFromDataUrl = async (dataUrl) => {
  const base64Match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(dataUrl);
  if (base64Match) {
    const buffer = Buffer.from(base64Match[2], 'base64');
    if (!buffer.length || buffer.length > MAX_ICON_BYTES) {
      return null;
    }

    const fileName = createIconFileName(sniffImageExtension(buffer) || getIconExtension(base64Match[1], ''));
    await fs.writeFile(path.join(UPLOADS_DIR, fileName), buffer);
    return `/uploads/${fileName}`;
  }

  const svgMatch = /^data:image\/svg\+xml(?:;charset=[^;,]+)?,(.*)$/is.exec(dataUrl);
  if (svgMatch && !/;base64,/i.test(dataUrl)) {
    const svg = decodeURIComponent(svgMatch[1]);
    const buffer = Buffer.from(svg, 'utf8');
    if (!buffer.length || buffer.length > MAX_ICON_BYTES) {
      return null;
    }

    const fileName = createIconFileName('.svg');
    await fs.writeFile(path.join(UPLOADS_DIR, fileName), buffer);
    return `/uploads/${fileName}`;
  }

  return null;
};

const buildIconFetchUrls = (iconUrl) => {
  const urls = [iconUrl];

  try {
    const parsed = new URL(iconUrl);
    if (parsed.hostname === 'host.docker.internal') {
      parsed.hostname = '127.0.0.1';
      urls.push(parsed.toString());
      parsed.hostname = 'localhost';
      urls.push(parsed.toString());
    }
  } catch (error) {
    // Ignore invalid URLs.
  }

  return [...new Set(urls)];
};

const persistIconFromUrl = async (iconUrl, options = {}) => {
  if (typeof iconUrl !== 'string' || !iconUrl.trim()) {
    return null;
  }

  const trimmed = iconUrl.trim();
  if (isLocalIcon(trimmed)) {
    return trimmed;
  }

  if (trimmed.startsWith('data:')) {
    if (!/^data:image\//i.test(trimmed)) {
      return null;
    }

    try {
      return await persistIconFromDataUrl(trimmed);
    } catch (error) {
      if (!options.quiet) {
        console.warn('Failed to persist data-URL icon:', error.message);
      }
      return null;
    }
  }

  let lastError = null;

  for (const candidateUrl of buildIconFetchUrls(trimmed)) {
    try {
      const response = await axios.get(candidateUrl, {
        responseType: 'arraybuffer',
        timeout: 4000,
        maxContentLength: MAX_ICON_BYTES,
        maxRedirects: 5,
        headers: ICON_HEADERS,
        validateStatus: (status) => status >= 200 && status < 300
      });

      const contentType = String(response.headers['content-type'] || '').toLowerCase();
      const buffer = Buffer.from(response.data);
      if (!buffer.length) {
        lastError = new Error('Empty icon response');
        continue;
      }

      if (!isProbablyImageBuffer(buffer, contentType)) {
        lastError = new Error(`Not an image: ${contentType || 'unknown type'}`);
        continue;
      }

      const extension = sniffImageExtension(buffer) || getIconExtension(contentType, candidateUrl);
      const fileName = createIconFileName(extension);
      await fs.writeFile(path.join(UPLOADS_DIR, fileName), buffer);
      return `/uploads/${fileName}`;
    } catch (error) {
      lastError = error;
    }
  }

  if (!options.quiet) {
    console.warn('Failed to persist icon:', trimmed, lastError?.message || 'unknown error');
  }

  return null;
};

const persistServiceIcon = async (service) => {
  if (!service || isLocalIcon(service.icon)) {
    return service;
  }

  const info = await getPageInfo(service.url);
  if (isLocalIcon(info.icon)) {
    return { ...service, icon: info.icon };
  }

  if (service.icon) {
    const persistedIcon = await persistIconFromUrl(service.icon);
    if (isLocalIcon(persistedIcon)) {
      return { ...service, icon: persistedIcon };
    }
  }

  return service;
};

const readData = async () => {
  try {
    const data = await fs.readJson(DATA_FILE);
    return {
      services: Array.isArray(data.services) ? data.services : [],
      lastScan: data.lastScan || null,
      scanRange: data.scanRange || DEFAULT_SCAN_RANGE
    };
  } catch (error) {
    return { ...DEFAULT_DATA };
  }
};

const writeData = async (data) => {
  await fs.ensureDir(UPLOADS_DIR);
  await fs.writeJson(DATA_FILE, {
    services: data.services || [],
    lastScan: data.lastScan || null,
    scanRange: data.scanRange || DEFAULT_SCAN_RANGE
  }, { spaces: 2 });
};

const persistExistingRemoteIcons = async () => {
  const currentData = await readData();
  let changed = false;
  const services = [];

  for (const service of currentData.services) {
    const nextService = await persistServiceIcon(service);
    if (nextService.icon !== service.icon) {
      changed = true;
    }
    services.push(nextService);
  }

  if (changed) {
    await writeData({ ...currentData, services });
    console.log('Cached remote service icons into the data volume');
  }
};

const normalizeServiceUrl = (rawUrl) => {
  if (typeof rawUrl !== 'string') {
    return null;
  }

  let candidate = rawUrl.trim();
  if (!candidate) {
    return null;
  }

  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `http://${candidate}`;
  }

  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return null;
    }

    const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
    const search = parsed.search || '';

    return `${parsed.protocol}//${parsed.host}${pathname}${search}`;
  } catch (error) {
    return null;
  }
};

const getServicePortFromUrl = (serviceUrl) => {
  try {
    const parsed = new URL(serviceUrl);
    if (parsed.port) {
      return parseInt(parsed.port, 10);
    }

    return parsed.protocol === 'https:' ? 443 : 80;
  } catch (error) {
    return 80;
  }
};

const isTruthy = (value) => {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
  }

  return false;
};

const removeUploadedIconIfLocal = async (iconPath) => {
  if (!isLocalIcon(iconPath)) {
    return;
  }

  const fileName = path.basename(iconPath);
  const filePath = path.join(UPLOADS_DIR, fileName);

  try {
    await fs.remove(filePath);
  } catch (error) {
    console.warn('Failed to remove uploaded icon:', filePath, error.message);
  }
};

const serviceMatchesScanTarget = (service, host, startPort, endPort) => {
  try {
    const parsed = new URL(service.url);
    const port = getServicePortFromUrl(service.url);

    return (
      parsed.hostname.toLowerCase() === host.toLowerCase()
      && port >= startPort
      && port <= endPort
    );
  } catch (error) {
    return false;
  }
};

const checkPort = (host, port, timeout = 1000) => {
  return new Promise((resolve) => {
    const socket = new net.Socket();

    socket.setTimeout(timeout);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });

    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });

    socket.connect(port, host);
  });
};

const resolveUrl = (baseUrl, href) => {
  if (typeof href !== 'string') {
    return null;
  }

  const trimmed = href.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('data:')) {
    return trimmed;
  }

  try {
    return new URL(trimmed, baseUrl).toString();
  } catch (error) {
    return null;
  }
};

const isIconRel = (rel) => {
  const parts = String(rel || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
  return parts.some((part) => (
    part === 'icon'
    || part === 'shortcut'
    || part === 'mask-icon'
    || part === 'fluid-icon'
    || part.includes('apple-touch-icon')
  ));
};

const parseIconSize = (sizes) => {
  const value = String(sizes || '').trim().toLowerCase();
  if (value === 'any') {
    return 512;
  }

  let maxSize = 0;
  for (const part of value.split(/\s+/)) {
    const match = part.match(/(\d+)\s*x\s*(\d+)/i);
    if (match) {
      maxSize = Math.max(maxSize, parseInt(match[1], 10), parseInt(match[2], 10));
    }
  }

  return maxSize;
};

const scoreIconCandidate = (candidate) => {
  let score = 0;
  const href = String(candidate.href || '').toLowerCase();
  const type = String(candidate.type || '').toLowerCase();
  const rel = String(candidate.rel || '').toLowerCase();
  const size = parseIconSize(candidate.sizes);

  if (href.startsWith('data:image/')) {
    score += 90;
  }

  if (type.includes('svg') || href.includes('.svg')) {
    score += 55;
  } else if (type.includes('png') || href.includes('.png')) {
    score += 45;
  } else if (type.includes('webp') || href.includes('.webp')) {
    score += 40;
  } else if (type.includes('jpeg') || type.includes('jpg') || href.includes('.jpg')) {
    score += 20;
  } else if (type.includes('icon') || href.includes('.ico')) {
    score += 15;
  }

  if (rel.includes('apple-touch-icon')) {
    score += 30;
  } else if (rel.includes('manifest')) {
    score += 25;
  } else if (rel.split(/[\s,]+/).includes('icon')) {
    score += 20;
  } else if (rel.includes('shortcut')) {
    score += 12;
  } else if (rel.includes('mask-icon')) {
    score += 8;
  } else if (rel === 'og:image' || rel === 'twitter:image') {
    score += 4;
  } else if (rel === 'fallback') {
    score += 2;
  }

  if (size >= 180) {
    score += 25;
  } else if (size >= 128) {
    score += 20;
  } else if (size >= 64) {
    score += 12;
  } else if (size >= 32) {
    score += 6;
  }

  return score;
};

const fetchPageHtml = async (url) => {
  const urlsToTry = [url];

  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:') {
      const httpsUrl = new URL(url);
      httpsUrl.protocol = 'https:';
      urlsToTry.push(httpsUrl.toString());
    }
  } catch (error) {
    // Ignore invalid URLs and keep the original candidate.
  }

  let lastError = null;

  for (const candidateUrl of urlsToTry) {
    try {
      const response = await axios.get(candidateUrl, {
        timeout: 5000,
        maxRedirects: 5,
        responseType: 'text',
        headers: PAGE_HEADERS,
        validateStatus: (status) => status >= 200 && status < 400
      });

      return {
        html: typeof response.data === 'string' ? response.data : '',
        finalUrl: response.request?.res?.responseUrl || candidateUrl
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error('Failed to fetch page');
};

const collectManifestIcons = async (manifestUrl) => {
  try {
    const response = await axios.get(manifestUrl, {
      timeout: 4000,
      headers: {
        ...PAGE_HEADERS,
        Accept: 'application/manifest+json,application/json;q=0.9,*/*;q=0.8'
      },
      validateStatus: (status) => status >= 200 && status < 300
    });

    const icons = response.data?.icons;
    if (!Array.isArray(icons)) {
      return [];
    }

    return icons
      .map((icon) => ({
        href: resolveUrl(manifestUrl, icon.src),
        type: icon.type || '',
        sizes: icon.sizes || '',
        rel: 'manifest'
      }))
      .filter((icon) => icon.href);
  } catch (error) {
    return [];
  }
};

const persistFirstAvailableIcon = async (candidates) => {
  const ranked = [...candidates]
    .filter((candidate) => candidate?.href)
    .sort((a, b) => scoreIconCandidate(b) - scoreIconCandidate(a));

  const seen = new Set();
  let attempts = 0;

  for (const candidate of ranked) {
    if (seen.has(candidate.href) || attempts >= 10) {
      continue;
    }

    seen.add(candidate.href);
    attempts += 1;

    const persisted = await persistIconFromUrl(candidate.href, { quiet: true });
    if (isLocalIcon(persisted)) {
      return persisted;
    }
  }

  return null;
};

const getPageInfo = async (url) => {
  const candidates = [];
  let title = url;
  let pageUrl = url;

  try {
    const page = await fetchPageHtml(url);
    pageUrl = page.finalUrl || url;

    if (page.html) {
      const $ = cheerio.load(page.html);
      title = ($('title').first().text() || '').replace(/\s+/g, ' ').trim() || url;

      let manifestHref = null;

      $('link[href]').each((_, element) => {
        const rel = $(element).attr('rel') || '';
        const href = resolveUrl(pageUrl, $(element).attr('href'));
        if (!href) {
          return;
        }

        const relParts = String(rel).toLowerCase().split(/[\s,]+/).filter(Boolean);
        if (relParts.includes('manifest')) {
          manifestHref = href;
          return;
        }

        if (!isIconRel(rel)) {
          return;
        }

        candidates.push({
          href,
          rel: String(rel).toLowerCase(),
          type: $(element).attr('type') || '',
          sizes: $(element).attr('sizes') || ''
        });
      });

      if (manifestHref) {
        const manifestIcons = await collectManifestIcons(manifestHref);
        candidates.push(...manifestIcons);
      }

      const metaImage = $('meta[property="og:image"]').attr('content')
        || $('meta[name="twitter:image"]').attr('content')
        || $('meta[name="msapplication-TileImage"]').attr('content')
        || $('meta[itemprop="image"]').attr('content');
      const metaHref = resolveUrl(pageUrl, metaImage);
      if (metaHref) {
        candidates.push({
          href: metaHref,
          rel: 'og:image',
          type: '',
          sizes: ''
        });
      }
    }
  } catch (error) {
    // Keep origin fallbacks even if the HTML page cannot be fetched.
  }

  try {
    const parsedPage = new URL(pageUrl);
    ORIGIN_ICON_PATHS.forEach((iconPath) => {
      candidates.push({
        href: `${parsedPage.origin}${iconPath}`,
        rel: 'fallback',
        type: '',
        sizes: ''
      });
    });

    const basePath = parsedPage.pathname.replace(/\/[^/]*$/, '');
    if (basePath && basePath !== '/') {
      ['/favicon.ico', '/favicon.svg', '/favicon.png', '/apple-touch-icon.png'].forEach((iconPath) => {
        candidates.push({
          href: `${parsedPage.origin}${basePath}${iconPath}`,
          rel: 'fallback',
          type: '',
          sizes: ''
        });
      });
    }
  } catch (error) {
    // Ignore invalid page URLs.
  }

  const icon = await persistFirstAvailableIcon(candidates);
  return { title, icon };
};

const handleMulterUpload = (req, res, next) => {
  upload.single('icon')(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    const message = error.code === 'LIMIT_FILE_SIZE'
      ? 'Icon is larger than 2MB'
      : (error.message || 'Upload failed');

    res.status(400).json({ error: message });
  });
};

app.get('/api/services', async (req, res) => {
  try {
    const data = await readData();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to read data' });
  }
});

app.post('/api/services/reorder', async (req, res) => {
  try {
    const { services } = req.body;
    if (!Array.isArray(services)) {
      return res.status(400).json({ error: 'Invalid data' });
    }

    const currentData = await readData();
    const currentServices = currentData.services || [];
    const serviceMap = new Map();

    currentServices.forEach((service) => {
      const key = normalizeServiceUrl(service.url);
      if (key) {
        serviceMap.set(key, service);
      }
    });

    const orderedServices = [];

    services.forEach((entry) => {
      const candidateUrl = typeof entry === 'string' ? entry : entry?.url;
      const normalizedUrl = normalizeServiceUrl(candidateUrl);
      if (!normalizedUrl) {
        return;
      }

      const existing = serviceMap.get(normalizedUrl);
      if (existing) {
        orderedServices.push(existing);
        serviceMap.delete(normalizedUrl);
      }
    });

    const nextServices = [...orderedServices, ...Array.from(serviceMap.values())];
    await writeData({ ...currentData, services: nextServices });

    res.json({ success: true, services: nextServices });
  } catch (error) {
    console.error('Reorder failed:', error);
    res.status(500).json({ error: 'Reorder failed' });
  }
});

app.post('/api/service/update', handleMulterUpload, async (req, res) => {
  try {
    const { oldUrl, url, title, removeIcon } = req.body;
    const file = req.file;

    const currentUrl = normalizeServiceUrl(oldUrl || url);
    const targetUrl = normalizeServiceUrl(url || oldUrl);

    if (!currentUrl || !targetUrl) {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    const currentData = await readData();
    const services = currentData.services || [];

    const idx = services.findIndex((service) => normalizeServiceUrl(service.url) === currentUrl);
    if (idx < 0) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const duplicateIndex = services.findIndex(
      (service, index) => index !== idx && normalizeServiceUrl(service.url) === targetUrl
    );
    if (duplicateIndex >= 0) {
      return res.status(409).json({ error: 'A service with this URL already exists' });
    }

    const existingService = services[idx];
    const nextService = {
      ...existingService,
      url: targetUrl,
      title: typeof title === 'string' && title.trim()
        ? title.trim()
        : (existingService.title || targetUrl),
      port: getServicePortFromUrl(targetUrl),
      manual: true,
      lastEditedAt: Date.now()
    };

    const shouldRemoveIcon = isTruthy(removeIcon);

    if (file) {
      await removeUploadedIconIfLocal(existingService.icon);
      nextService.icon = `/uploads/${file.filename}`;
    } else if (shouldRemoveIcon) {
      await removeUploadedIconIfLocal(existingService.icon);
      nextService.icon = null;
    }

    services[idx] = nextService;
    await writeData({ ...currentData, services });

    res.json({ success: true, service: nextService });
  } catch (error) {
    console.error('Update failed:', error);
    res.status(500).json({ error: 'Update failed' });
  }
});

app.post('/api/service/delete', async (req, res) => {
  try {
    const normalizedUrl = normalizeServiceUrl(req.body?.url);
    if (!normalizedUrl) {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    const currentData = await readData();
    const services = currentData.services || [];
    const idx = services.findIndex((service) => normalizeServiceUrl(service.url) === normalizedUrl);

    if (idx < 0) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const [removedService] = services.splice(idx, 1);
    await removeUploadedIconIfLocal(removedService.icon);

    await writeData({ ...currentData, services });
    res.json({ success: true, removedUrl: removedService.url });
  } catch (error) {
    console.error('Delete failed:', error);
    res.status(500).json({ error: 'Delete failed' });
  }
});

app.post('/api/service/add', async (req, res) => {
  try {
    const normalizedUrl = normalizeServiceUrl(req.body?.url);
    if (!normalizedUrl) {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    const currentData = await readData();
    const services = currentData.services || [];
    const exists = services.some((service) => normalizeServiceUrl(service.url) === normalizedUrl);

    if (exists) {
      return res.status(409).json({ error: 'Service already exists' });
    }

    const info = await getPageInfo(normalizedUrl);

    const newService = {
      url: normalizedUrl,
      port: getServicePortFromUrl(normalizedUrl),
      title: info.title || normalizedUrl,
      icon: info.icon,
      status: 'manual',
      manual: true,
      lastSeen: Date.now()
    };

    services.push(newService);

    await writeData({ ...currentData, services });
    res.json({ success: true, service: newService });
  } catch (error) {
    console.error('Add failed:', error);
    res.status(500).json({ error: 'Failed to add service' });
  }
});

app.post('/api/scan', async (req, res) => {
  const { startPort, endPort, host = 'localhost' } = req.body;

  const start = parseInt(startPort, 10);
  const end = parseInt(endPort, 10);
  const targetHost = typeof host === 'string' && host.trim() ? host.trim() : 'localhost';

  if (
    Number.isNaN(start)
    || Number.isNaN(end)
    || start < 1
    || end > 65535
    || start > end
  ) {
    return res.status(400).json({ error: 'Invalid scan range' });
  }

  res.json({ message: 'Scan started' });

  console.log(`Scanning ${targetHost} ports ${start}-${end}...`);

  const foundServices = [];
  for (let port = start; port <= end; port++) {
    const isOpen = await checkPort(targetHost, port);
    if (!isOpen) {
      continue;
    }

    const url = normalizeServiceUrl(`http://${targetHost}:${port}`);
    if (!url) {
      continue;
    }

    const info = await getPageInfo(url);

    foundServices.push({
      port,
      url,
      title: info.title || url,
      icon: info.icon,
      status: 'online',
      lastSeen: Date.now()
    });
  }

  try {
    const currentData = await readData();
    let nextServices = [...(currentData.services || [])];
    const foundByUrl = new Map(foundServices.map((service) => [normalizeServiceUrl(service.url), service]));

    for (const found of foundServices) {
      const foundKey = normalizeServiceUrl(found.url);
      const idx = nextServices.findIndex((service) => normalizeServiceUrl(service.url) === foundKey);

      if (idx >= 0) {
        const existing = nextServices[idx];
        if (existing.manual) {
          nextServices[idx] = {
            ...existing,
            status: 'online',
            port: found.port,
            lastSeen: Date.now(),
            icon: isLocalIcon(existing.icon) ? existing.icon : (found.icon || existing.icon)
          };
        } else {
          nextServices[idx] = {
            ...existing,
            ...found,
            icon: isLocalIcon(existing.icon) ? existing.icon : (found.icon || existing.icon),
            lastSeen: Date.now()
          };
        }
      } else {
        nextServices.push({
          ...found,
          lastSeen: Date.now()
        });
      }
    }

    nextServices = nextServices.map((service) => {
      const serviceKey = normalizeServiceUrl(service.url);
      if (!serviceKey) {
        return service;
      }

      if (foundByUrl.has(serviceKey)) {
        return service;
      }

      if (serviceMatchesScanTarget(service, targetHost, start, end)) {
        return { ...service, status: 'offline' };
      }

      return service;
    });

    await writeData({
      services: nextServices,
      lastScan: Date.now(),
      scanRange: { start, end, host: targetHost }
    });

    console.log('Scan complete. Found:', foundServices.length);
  } catch (error) {
    console.error('Error saving scan results:', error);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Persistent data directory: ${DATA_DIR}`);
  persistExistingRemoteIcons().catch((error) => {
    console.warn('Could not cache existing icons:', error.message);
  });
});
