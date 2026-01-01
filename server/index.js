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

// Ensure directories exist
fs.ensureDirSync(UPLOADS_DIR);
fs.ensureFileSync(DATA_FILE);

// Configure Multer
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOADS_DIR)
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    cb(null, 'icon-' + uniqueSuffix + path.extname(file.originalname))
  }
});

const upload = multer({ storage: storage });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

if (!fs.existsSync(DATA_FILE) || fs.readFileSync(DATA_FILE, 'utf8').trim() === '') {
    fs.writeJsonSync(DATA_FILE, { services: [], lastScan: null });
}

// Helpers
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
        
        let title = $('title').text() || url;
        let icon = $('link[rel="icon"]').attr('href') || $('link[rel="shortcut icon"]').attr('href');
        
        if (icon && !icon.startsWith('http')) {
             const u = new URL(url);
             if (icon.startsWith('//')) {
                icon = u.protocol + icon;
             } else if (icon.startsWith('/')) {
                icon = u.origin + icon;
             } else {
                icon = u.origin + '/' + icon;
             }
        }
        
        return { title, icon };

    } catch (e) {
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
        const { services } = req.body; // Expects full array of services in new order
        if (!Array.isArray(services)) {
             return res.status(400).json({ error: 'Invalid data' });
        }

        const currentData = await fs.readJson(DATA_FILE);
        // We trust the client to send the full list with correct objects. 
        // But simpler: the client sends the new ORDER of URLs? 
        // Or just the full service objects reordered. 
        // Let's assume full objects for now to be simple, but we should probably merge with existing just in case.
        
        // Better safety: Client sends IDs or URLs. We reorder our existing list based on that.
        // But since we don't have IDs, URL is the key.
        
        // Reconstruct services list based on input order
        // req.body.services might be the full object list from frontend state.
        
        await fs.writeJson(DATA_FILE, { ...currentData, services: services });
        
        res.json({ success: true });
    } catch (err) {
        console.error('Reorder failed:', err);
        res.status(500).json({ error: 'Reorder failed' });
    }
});

app.post('/api/service/update', upload.single('icon'), async (req, res) => {
    try {
        const { url, title } = req.body;
        const file = req.file;
        
        console.log('Updating service:', url, title, file ? file.filename : 'no-file');

        const currentData = await fs.readJson(DATA_FILE);
        let services = currentData.services || [];
        
        const idx = services.findIndex(s => s.url === url);
        
        const updateData = {
            manual: true,
            title: title
        };
        
        if (file) {
            updateData.icon = '/uploads/' + file.filename;
        }
        
        if (idx >= 0) {
            services[idx] = { ...services[idx], ...updateData };
        } else {
             services.push({
                 url,
                 port: new URL(url).port || 80,
                 status: 'manual',
                 ...updateData
             });
        }
        
        // Save
        await fs.writeJson(DATA_FILE, { ...currentData, services });
        res.json({ success: true, services });
        
    } catch (err) {
        console.error('Update failed:', err);
        res.status(500).json({ error: 'Update failed' });
    }
});

app.post('/api/service/add', async (req, res) => {
    try {
        let { url } = req.body;
        if (!url.startsWith('http')) {
            url = 'http://' + url;
        }

        console.log('Adding service:', url);

        // Try to fetch info
        const info = await getPageInfo(url);
        
        const newService = {
            url,
            port: new URL(url).port || (url.startsWith('https') ? 443 : 80),
            title: info.title,
            icon: info.icon,
            status: 'manual',
            manual: true, // Mark as manual so scanner doesn't overwrite title/icon
            lastSeen: Date.now()
        };

        const currentData = await fs.readJson(DATA_FILE);
        let services = currentData.services || [];
        
        // Check if exists
        const idx = services.findIndex(s => s.url === url);
        if (idx >= 0) {
            // Update existing? Or just return success saying it's there.
            // Let's update it but keep any previous manual edits if we want? 
            // The user intention "add" implies they want this new one. 
            // But if it's already there, maybe just ensure it's marked manual now.
            services[idx] = { ...services[idx], ...newService };
        } else {
            services.push(newService);
        }

        await fs.writeJson(DATA_FILE, { ...currentData, services });
        res.json({ success: true, service: newService });

    } catch (err) {
        console.error('Add failed:', err);
        res.status(500).json({ error: 'Failed to add service' });
    }
});

app.post('/api/scan', async (req, res) => {
    const { startPort, endPort, host = 'localhost' } = req.body;
    
    if (!startPort || !endPort) {
        return res.status(400).json({ error: 'Missing startPort or endPort' });
    }

    res.json({ message: 'Scan started' });

    console.log(`Scanning ${host} ports ${startPort}-${endPort}...`);

    const foundServices = [];
    for (let port = parseInt(startPort); port <= parseInt(endPort); port++) {
        const isOpen = await checkPort(host, port);
        if (isOpen) {
            const url = `http://${host}:${port}`;
            const info = await getPageInfo(url);
            
            foundServices.push({
                port,
                url,
                title: info.title,
                icon: info.icon,
                status: 'online'
            });
        }
    }

    try {
        const currentData = await fs.readJson(DATA_FILE);
        let newServicesList = [...(currentData.services || [])];
        
        foundServices.forEach(found => {
            const idx = newServicesList.findIndex(s => s.url === found.url);
            if (idx >= 0) {
                // Determine if we should overwrite
                // If it was manually edited, we might want to keep the title/icon
                // but update the status or lastSeen.
                const existing = newServicesList[idx];
                if (existing.manual) {
                    // Update only status/lastSeen, keep title/icon if manual
                     newServicesList[idx] = { 
                         ...existing, 
                         status: 'online', 
                         lastSeen: Date.now() 
                         // Don't overwrite title/icon
                     };
                } else {
                    newServicesList[idx] = { ...existing, ...found, lastSeen: Date.now() };
                }
            } else {
                newServicesList.push({ ...found, lastSeen: Date.now() });
            }
        });

        await fs.writeJson(DATA_FILE, { 
            services: newServicesList, 
            lastScan: Date.now(),
            scanRange: { start: startPort, end: endPort, host } 
        });
        
        console.log('Scan complete. Found:', foundServices.length);
        
    } catch (err) {
        console.error('Error saving scan results:', err);
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
