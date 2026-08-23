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

### Run the published image

The Docker image is published to GitHub Container Registry on every [GitHub Release](https://github.com/timbornemann/Docker-Dashboard/releases).

Repository: [https://github.com/timbornemann/Docker-Dashboard](https://github.com/timbornemann/Docker-Dashboard)  
Image: [`ghcr.io/timbornemann/docker-dashboard:latest`](https://github.com/timbornemann/Docker-Dashboard/pkgs/container/docker-dashboard)

Create a GitHub Release to build and publish a new image. After the first publish, set the package visibility to **Public** under [GitHub Packages](https://github.com/timbornemann/Docker-Dashboard/pkgs/container/docker-dashboard) so anyone can pull it without logging in.

Pull and run the current release:

```bash
docker pull ghcr.io/timbornemann/docker-dashboard:latest
docker run -d --name docker-dashboard -p 3000:8080 -v docker-dashboard-data:/app/data --add-host=host.docker.internal:host-gateway --restart unless-stopped ghcr.io/timbornemann/docker-dashboard:latest
```

Or with Compose (also uses `:latest`):

```bash
docker compose pull
docker compose up -d
```

The dashboard will be available at [http://localhost:3000](http://localhost:3000).

`:latest` always points to the newest published release. Pin a version with e.g. `ghcr.io/timbornemann/docker-dashboard:1.0.0` if you need a specific tag.

### Build locally with Docker

```bash
docker compose up --build
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
