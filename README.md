# Docker-Dashboard

A modern, self-hosted dashboard to manage and organize your local services, Docker containers, and ports. Built with React (Vite) and Node.js (Express).

## Features

- **Service Scanning**: Automatically scan a range of ports to discover running HTTP services.
- **Manual Management**: Add custom services manually if they aren't discovered.
- **Full CRUD for Services**: Add, edit (title, URL, icon), and delete services.
- **Drag & Drop**: Reorder your services on the dashboard easily.
- **Customization**: Automatically fetches titles and favicons, with support for custom icon uploads.
- **Quick Filtering**: Search services and filter by status (online, offline, manual).
- **Status Tracking**: Shows online/offline state and remembers last scan details.
- **Persistency**: Cards, layout, uploaded icons, and cached images are stored in a Docker volume and shared for every visitor.

## Tech Stack

- **Client**: React, Vite, TailwindCSS (inferred), @dnd-kit (Drag & Drop)
- **Server**: Node.js, Express, Cheerio (Metadata scraping), Multer (Image uploads)
- **Deployment**: Docker, Docker Compose

## Getting Started

### Prerequisites

- Node.js (v18+ recommended)
- Docker & Docker Compose (optional, for containerized run)

### Running Locally

1. **Install Dependencies**
   ```bash
   # Install server dependencies
   cd server
   npm install

   # Install client dependencies
   cd ../client
   npm install
   ```

2. **Start the Server**
   ```bash
   cd server
   npm start
   # Server runs on http://localhost:8080
   ```

3. **Start the Client**
   ```bash
   cd client
   npm run dev
   # Client usually runs on http://localhost:5173
   ```

### Running with Docker

You can spin up the entire stack with a single command:

```bash
docker-compose up --build
```

The dashboard will be available at [http://localhost:3000](http://localhost:3000).

All dashboard data lives in the named Docker volume `docker-dashboard-data`:

- self-created cards and their order
- uploaded icons and images
- automatically cached favicons so other devices and visitors see the same pictures

On first start, existing files from `server/data` are copied into that volume automatically.

Container rebuilds keep this data. Remove it only if you intentionally want a reset:

```bash
docker compose down
docker volume rm docker-dashboard-data
```

## Project Structure

- **/client**: React frontend application.
- **/server**: Express API backend.
- **/server/data**: Local-dev copy of persistent data (`services.json`) and uploaded icons. In Docker this is the named volume `docker-dashboard-data` mounted at `/app/data`.

## API Endpoints

- `GET /api/services`: Get all services.
- `POST /api/service/add`: Add a new service manually.
- `POST /api/service/update`: Update a service (URL, title, icon).
- `POST /api/service/delete`: Delete a service.
- `POST /api/services/reorder`: Update the order of services.
- `POST /api/scan`: Trigger a port scan.
