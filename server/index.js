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
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'services.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DEFAULT_SCAN_RANGE = { start: 3000, end: 3010, host: 'host.docker.internal' };

// Ensure directories exist
fs.ensureDirSync(UPLOADS_DIR);
fs.ensureFileSync(DATA_FILE);

// Configure Multer
const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, UPLOADS_DIR);
  },
  filename(req, file, cb) {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `icon-${uniqueSuffix}${path.extname(file.originalname)}`);
  }
});

const upload = multer({ storage });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

if (!fs.existsSync(DATA_FILE) || fs.readFileSync(DATA_FILE, 'utf8').trim() === '') {
  fs.writeJsonSync(DATA_FILE, { services: [], lastScan: null, scanRange: DEFAULT_SCAN_RANGE });
}

// Helpers
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
  if (typeof iconPath !== 'string' || !iconPath.startsWith('/uploads/')) {
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

const getPageInfo = async (url) => {
  try {
    const response = await axios.get(url, { timeout: 2000 });
    const html = response.data;
    const $ = cheerio.load(html);

    const title = $('title').text() || url;
    let icon = $('link[rel="icon"]').attr('href') || $('link[rel="shortcut icon"]').attr('href');

    if (icon && !icon.startsWith('http')) {
      const u = new URL(url);
      if (icon.startsWith('//')) {
        icon = u.protocol + icon;
      } else if (icon.startsWith('/')) {
        icon = u.origin + icon;
      } else {
        icon = `${u.origin}/${icon}`;
      }
    }

    return { title, icon };
  } catch (error) {
    return { title: url, icon: null };
  }
};

// Routes
app.get('/api/services', async (req, res) => {
  try {
    const data = await fs.readJson(DATA_FILE);
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

    const currentData = await fs.readJson(DATA_FILE);
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
    await fs.writeJson(DATA_FILE, { ...currentData, services: nextServices });

    res.json({ success: true, services: nextServices });
  } catch (error) {
    console.error('Reorder failed:', error);
    res.status(500).json({ error: 'Reorder failed' });
  }
});

app.post('/api/service/update', upload.single('icon'), async (req, res) => {
  try {
    const { oldUrl, url, title, removeIcon } = req.body;
    const file = req.file;

    const currentUrl = normalizeServiceUrl(oldUrl || url);
    const targetUrl = normalizeServiceUrl(url || oldUrl);

    if (!currentUrl || !targetUrl) {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    const currentData = await fs.readJson(DATA_FILE);
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
    await fs.writeJson(DATA_FILE, { ...currentData, services });

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

    const currentData = await fs.readJson(DATA_FILE);
    const services = currentData.services || [];
    const idx = services.findIndex((service) => normalizeServiceUrl(service.url) === normalizedUrl);

    if (idx < 0) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const [removedService] = services.splice(idx, 1);
    await removeUploadedIconIfLocal(removedService.icon);

    await fs.writeJson(DATA_FILE, { ...currentData, services });
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

    const currentData = await fs.readJson(DATA_FILE);
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

    await fs.writeJson(DATA_FILE, { ...currentData, services });
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
    const currentData = await fs.readJson(DATA_FILE);
    let nextServices = [...(currentData.services || [])];
    const foundByUrl = new Map(foundServices.map((service) => [normalizeServiceUrl(service.url), service]));

    foundServices.forEach((found) => {
      const foundKey = normalizeServiceUrl(found.url);
      const idx = nextServices.findIndex((service) => normalizeServiceUrl(service.url) === foundKey);

      if (idx >= 0) {
        const existing = nextServices[idx];
        if (existing.manual) {
          nextServices[idx] = {
            ...existing,
            status: 'online',
            port: found.port,
            lastSeen: Date.now()
          };
        } else {
          nextServices[idx] = { ...existing, ...found, lastSeen: Date.now() };
        }
      } else {
        nextServices.push({ ...found, lastSeen: Date.now() });
      }
    });

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

    await fs.writeJson(DATA_FILE, {
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
});
