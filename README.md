# Docker-Dashboard

A modern, self-hosted dashboard to manage and organize your local services, Docker containers, and ports. Built with React (Vite) and Node.js (Express).

## Features

- **Service Scanning**: Automatically scan a range of ports to discover running HTTP services.
- **Manual Management**: Add custom services manually if they aren't discovered.
- **Drag & Drop**: Reorder your services on the dashboard easily.
- **Customization**: Automatically fetches titles and favicons, with support for custom icon uploads.
- **Persistency**: Layout and service data are saved locally.

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

The dashboard will be available at [http://localhost:2999](http://localhost:2999).

## Project Structure

- **/client**: React frontend application.
- **/server**: Express API backend.
- **/server/data**: Stores persistent data (`services.json`) and uploaded icons.

## API Endpoints

- `GET /api/services`: Get all services.
- `POST /api/service/add`: Add a new service manually.
- `POST /api/service/update`: Update a service (title, icon).
- `POST /api/services/reorder`: Update the order of services.
- `POST /api/scan`: Trigger a port scan.
