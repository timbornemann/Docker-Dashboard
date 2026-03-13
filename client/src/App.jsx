import React, { useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  rectSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

const API_BASE = import.meta.env.VITE_API_URL || '';
const INITIAL_SCAN_RANGE = { start: 3000, end: 3010, host: 'host.docker.internal' };

function SortableItem(props) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: props.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    position: 'relative',
    touchAction: 'none'
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} className="card-wrapper">
      {props.children}
    </div>
  );
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatDateTime(timestamp) {
  if (!timestamp) {
    return 'Noch nie';
  }

  return new Date(timestamp).toLocaleString();
}

function getServiceStatus(service) {
  if (service.status === 'online') {
    return 'online';
  }

  if (service.status === 'offline') {
    return 'offline';
  }

  if (service.manual) {
    return 'manual';
  }

  return 'unknown';
}

function getOpenUrl(serviceUrl) {
  try {
    const parsed = new URL(serviceUrl);
    if (parsed.hostname === 'host.docker.internal') {
      parsed.hostname = window.location.hostname;
    }

    return parsed.toString();
  } catch (error) {
    return serviceUrl;
  }
}

function App() {
  const [data, setData] = useState({ services: [], lastScan: null, scanRange: INITIAL_SCAN_RANGE });
  const [scanRange, setScanRange] = useState(INITIAL_SCAN_RANGE);

  const [isScanning, setIsScanning] = useState(false);
  const [isMutating, setIsMutating] = useState(false);

  const [message, setMessage] = useState(null);

  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const [addingService, setAddingService] = useState(false);
  const [newServiceUrl, setNewServiceUrl] = useState('');

  const [editingService, setEditingService] = useState(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const showMessage = (text, type = 'success') => {
    setMessage({ text, type });
  };

  const fetchData = async (silent = false) => {
    try {
      const res = await fetch(`${API_BASE}/api/services`);
      if (!res.ok) {
        throw new Error('API request failed');
      }

      const json = await res.json();
      const normalizedScanRange = {
        start: Number(json?.scanRange?.start) || INITIAL_SCAN_RANGE.start,
        end: Number(json?.scanRange?.end) || INITIAL_SCAN_RANGE.end,
        host: json?.scanRange?.host || INITIAL_SCAN_RANGE.host,
      };

      const normalizedData = {
        services: Array.isArray(json.services) ? json.services : [],
        lastScan: json.lastScan || null,
        scanRange: normalizedScanRange,
      };

      setData(normalizedData);
      setScanRange(normalizedScanRange);
      return normalizedData;
    } catch (error) {
      console.error('Failed to fetch services', error);
      if (!silent) {
        showMessage('Daten konnten nicht geladen werden.', 'error');
      }
      return null;
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  useEffect(() => {
    if (!message) {
      return undefined;
    }

    const timer = setTimeout(() => {
      setMessage(null);
    }, 4000);

    return () => {
      clearTimeout(timer);
    };
  }, [message]);

  useEffect(() => {
    if (!addingService && !editingService) {
      return undefined;
    }

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setAddingService(false);
        setEditingService(null);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [addingService, editingService]);

  const isFiltering = searchTerm.trim().length > 0 || statusFilter !== 'all';

  const visibleServices = useMemo(() => {
    const normalizedSearch = searchTerm.trim().toLowerCase();

    return data.services.filter((service) => {
      const status = getServiceStatus(service);
      const matchesStatus = statusFilter === 'all'
        ? true
        : statusFilter === 'manual'
          ? Boolean(service.manual)
          : status === statusFilter;

      const haystack = [
        service.title || '',
        service.url || '',
        String(service.port || ''),
      ].join(' ').toLowerCase();

      const matchesSearch = !normalizedSearch || haystack.includes(normalizedSearch);

      return matchesStatus && matchesSearch;
    });
  }, [data.services, searchTerm, statusFilter]);

  const handleScan = async () => {
    const start = Number(scanRange.start);
    const end = Number(scanRange.end);
    const host = String(scanRange.host || '').trim() || INITIAL_SCAN_RANGE.host;

    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || start > end) {
      showMessage('Bitte gib einen gueltigen Portbereich ein (1-65535).', 'error');
      return;
    }

    setIsScanning(true);

    try {
      const res = await fetch(`${API_BASE}/api/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startPort: start,
          endPort: end,
          host,
        })
      });

      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || 'Scan request failed');
      }

      const previousLastScan = data.lastScan;
      let scanFinished = false;

      for (let attempt = 0; attempt < 8; attempt += 1) {
        await wait(1500);
        const updated = await fetchData(true);
        if (updated?.lastScan && updated.lastScan !== previousLastScan) {
          scanFinished = true;
          break;
        }
      }

      if (scanFinished) {
        showMessage('Scan abgeschlossen.', 'success');
      } else {
        showMessage('Scan wurde gestartet und laeuft ggf. noch im Hintergrund.', 'success');
      }
    } catch (error) {
      console.error('Scan failed', error);
      showMessage(error.message || 'Scan fehlgeschlagen.', 'error');
    } finally {
      setIsScanning(false);
    }
  };

  const handleAddService = async () => {
    const url = newServiceUrl.trim();
    if (!url) {
      showMessage('Bitte gib eine Service-URL ein.', 'error');
      return;
    }

    setIsMutating(true);
    try {
      const res = await fetch(`${API_BASE}/api/service/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });

      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || 'Service konnte nicht hinzugefuegt werden');
      }

      setAddingService(false);
      setNewServiceUrl('');
      await fetchData(true);
      showMessage('Service wurde hinzugefuegt.', 'success');
    } catch (error) {
      console.error('Add failed', error);
      showMessage(error.message || 'Fehler beim Hinzufuegen.', 'error');
    } finally {
      setIsMutating(false);
    }
  };

  const openEditModal = (event, service) => {
    event.preventDefault();
    event.stopPropagation();

    setEditingService({
      oldUrl: service.url,
      url: service.url,
      title: service.title || '',
      newIconFile: null,
      removeIcon: false,
      currentIcon: service.icon || null,
    });
  };

  const handleUpdateService = async () => {
    if (!editingService) {
      return;
    }

    const updatedUrl = editingService.url.trim();
    if (!updatedUrl) {
      showMessage('Die URL darf nicht leer sein.', 'error');
      return;
    }

    setIsMutating(true);

    try {
      const formData = new FormData();
      formData.append('oldUrl', editingService.oldUrl);
      formData.append('url', updatedUrl);
      formData.append('title', editingService.title || '');
      formData.append('removeIcon', editingService.removeIcon ? 'true' : 'false');
      if (editingService.newIconFile) {
        formData.append('icon', editingService.newIconFile);
      }

      const res = await fetch(`${API_BASE}/api/service/update`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || 'Service konnte nicht aktualisiert werden');
      }

      setEditingService(null);
      await fetchData(true);
      showMessage('Service wurde aktualisiert.', 'success');
    } catch (error) {
      console.error('Update failed', error);
      showMessage(error.message || 'Fehler beim Speichern.', 'error');
    } finally {
      setIsMutating(false);
    }
  };

  const handleDeleteService = async (event, service) => {
    event.preventDefault();
    event.stopPropagation();

    const confirmed = window.confirm(`Service \"${service.title || service.url}\" wirklich loeschen?`);
    if (!confirmed) {
      return;
    }

    setIsMutating(true);

    try {
      const res = await fetch(`${API_BASE}/api/service/delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: service.url }),
      });

      if (!res.ok) {
        const error = await res.json().catch(() => ({}));
        throw new Error(error.error || 'Service konnte nicht geloescht werden');
      }

      await fetchData(true);
      showMessage('Service wurde geloescht.', 'success');
    } catch (error) {
      console.error('Delete failed', error);
      showMessage(error.message || 'Fehler beim Loeschen.', 'error');
    } finally {
      setIsMutating(false);
    }
  };

  const handleDragEnd = async (event) => {
    if (isFiltering) {
      return;
    }

    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }

    const oldIndex = data.services.findIndex((service) => service.url === active.id);
    const newIndex = data.services.findIndex((service) => service.url === over.id);

    if (oldIndex < 0 || newIndex < 0) {
      return;
    }

    const reorderedServices = arrayMove(data.services, oldIndex, newIndex);
    setData((previous) => ({ ...previous, services: reorderedServices }));

    try {
      const res = await fetch(`${API_BASE}/api/services/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          services: reorderedServices.map((service) => service.url),
        }),
      });

      if (!res.ok) {
        throw new Error('Reorder failed');
      }
    } catch (error) {
      console.error('Failed to save order', error);
      showMessage('Sortierung konnte nicht gespeichert werden.', 'error');
      await fetchData(true);
    }
  };

  const renderCardBody = (service) => {
    const status = getServiceStatus(service);

    return (
      <>
        <a
          href={getOpenUrl(service.url)}
          target="_blank"
          rel="noopener noreferrer"
          className="card"
        >
          <div className="card-icon">
            {service.icon ? (
              <img
                src={service.icon.startsWith('/') ? `${API_BASE}${service.icon}` : service.icon}
                alt="service icon"
                onError={(event) => {
                  event.currentTarget.style.display = 'none';
                  if (event.currentTarget.parentElement) {
                    event.currentTarget.parentElement.textContent = 'Web';
                  }
                }}
              />
            ) : 'Web'}
          </div>
          <div className="card-title">{service.title || 'Unbenannter Service'}</div>
          <div className="card-url" title={service.url}>{service.url}</div>
          <div className={`status-pill status-${status}`}>
            {status === 'online' && 'Online'}
            {status === 'offline' && 'Offline'}
            {status === 'manual' && 'Manuell'}
            {status === 'unknown' && 'Unbekannt'}
            {service.port ? ` - :${service.port}` : ''}
          </div>
          <div className="card-last-seen">Zuletzt gesehen: {formatDateTime(service.lastSeen)}</div>
        </a>

        <div className="card-actions" onPointerDown={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="card-action-btn edit"
            onClick={(event) => openEditModal(event, service)}
          >
            Bearbeiten
          </button>
          <button
            type="button"
            className="card-action-btn delete"
            onClick={(event) => handleDeleteService(event, service)}
          >
            Loeschen
          </button>
        </div>
      </>
    );
  };

  return (
    <>
      <header>
        <h1>Docker Dashboard</h1>
        <div className="controls">
          <button
            className="primary-btn ghost"
            onClick={() => setAddingService(true)}
          >
            + Service hinzufuegen
          </button>

          <div className="input-group host-group">
            <label htmlFor="scan-host">Host</label>
            <input
              id="scan-host"
              type="text"
              value={scanRange.host}
              onChange={(event) => setScanRange({ ...scanRange, host: event.target.value })}
              placeholder="host.docker.internal"
            />
          </div>

          <div className="input-group">
            <label htmlFor="scan-start">Ports</label>
            <input
              id="scan-start"
              type="number"
              min="1"
              max="65535"
              value={scanRange.start}
              onChange={(event) => setScanRange({ ...scanRange, start: event.target.value })}
            />
            <span className="input-separator">-</span>
            <input
              id="scan-end"
              type="number"
              min="1"
              max="65535"
              value={scanRange.end}
              onChange={(event) => setScanRange({ ...scanRange, end: event.target.value })}
            />
          </div>

          <button className="primary-btn" onClick={handleScan} disabled={isScanning}>
            {isScanning ? <div className="loading-spinner" /> : 'Netzwerk scannen'}
          </button>
        </div>
      </header>

      <main>
        {message && (
          <div className={`feedback ${message.type === 'error' ? 'error' : 'success'}`}>
            <span>{message.text}</span>
            <button type="button" className="feedback-close" onClick={() => setMessage(null)}>x</button>
          </div>
        )}

        <div className="secondary-controls">
          <input
            type="text"
            className="search-input"
            placeholder="Suche nach Name, URL oder Port"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
          />

          <select
            className="filter-select"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
          >
            <option value="all">Alle Status</option>
            <option value="online">Nur online</option>
            <option value="offline">Nur offline</option>
            <option value="manual">Nur manuell</option>
          </select>

          <div className="scan-meta">
            Letzter Scan: {formatDateTime(data.lastScan)}
          </div>
        </div>

        {isFiltering && data.services.length > 0 && (
          <p className="hint">Hinweis: Drag and Drop ist waehrend Suche/Filter deaktiviert.</p>
        )}

        {visibleServices.length === 0 ? (
          <div className="empty-state">
            {data.services.length === 0 ? (
              <>
                <h2>Keine Services gefunden</h2>
                <p>Scanne einen Portbereich oder fuege einen Service manuell hinzu.</p>
              </>
            ) : (
              <>
                <h2>Keine Treffer</h2>
                <p>Mit den aktuellen Such- und Filtereinstellungen wurden keine Services gefunden.</p>
              </>
            )}
          </div>
        ) : isFiltering ? (
          <div className="grid">
            {visibleServices.map((service) => (
              <div key={service.url} className="card-wrapper static-card">
                {renderCardBody(service)}
              </div>
            ))}
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={data.services.map((service) => service.url)}
              strategy={rectSortingStrategy}
            >
              <div className="grid">
                {data.services.map((service) => (
                  <SortableItem key={service.url} id={service.url}>
                    {renderCardBody(service)}
                  </SortableItem>
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </main>

      {addingService && (
        <div className="modal-overlay" onMouseDown={() => setAddingService(false)}>
          <div className="modal" onMouseDown={(event) => event.stopPropagation()}>
            <h2>Neuen Service hinzufuegen</h2>
            <p className="modal-description">
              URL eingeben, Titel und Icon werden automatisch ermittelt, koennen spaeter geaendert werden.
            </p>
            <div className="form-group">
              <label htmlFor="service-url">Service URL</label>
              <input
                id="service-url"
                type="text"
                placeholder="http://localhost:8080"
                value={newServiceUrl}
                onChange={(event) => setNewServiceUrl(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    handleAddService();
                  }
                }}
              />
            </div>
            <div className="modal-actions">
              <button onClick={() => setAddingService(false)} className="cancel-btn" type="button">Abbrechen</button>
              <button onClick={handleAddService} className="primary-btn" type="button" disabled={isMutating}>
                {isMutating ? 'Wird hinzugefuegt...' : 'Service speichern'}
              </button>
            </div>
          </div>
        </div>
      )}

      {editingService && (
        <div className="modal-overlay" onMouseDown={() => setEditingService(null)}>
          <div className="modal" onMouseDown={(event) => event.stopPropagation()}>
            <h2>Service bearbeiten</h2>
            <div className="form-group">
              <label htmlFor="edit-url">Service URL</label>
              <input
                id="edit-url"
                type="text"
                value={editingService.url}
                onChange={(event) => setEditingService({ ...editingService, url: event.target.value })}
              />
            </div>
            <div className="form-group">
              <label htmlFor="edit-title">Titel</label>
              <input
                id="edit-title"
                type="text"
                value={editingService.title}
                onChange={(event) => setEditingService({ ...editingService, title: event.target.value })}
              />
            </div>
            <div className="form-group">
              <label htmlFor="edit-icon">Icon hochladen</label>
              <input
                id="edit-icon"
                type="file"
                accept="image/*"
                onChange={(event) => {
                  const file = event.target.files?.[0] || null;
                  setEditingService({
                    ...editingService,
                    newIconFile: file,
                    removeIcon: file ? false : editingService.removeIcon,
                  });
                }}
              />
              {editingService.currentIcon && !editingService.newIconFile && (
                <p className="muted-text">Aktuelles Icon vorhanden</p>
              )}
              <label className="checkbox-row" htmlFor="remove-icon">
                <input
                  id="remove-icon"
                  type="checkbox"
                  checked={editingService.removeIcon}
                  disabled={Boolean(editingService.newIconFile)}
                  onChange={(event) => setEditingService({
                    ...editingService,
                    removeIcon: event.target.checked,
                  })}
                />
                Icon entfernen
              </label>
            </div>
            <div className="modal-actions">
              <button onClick={() => setEditingService(null)} className="cancel-btn" type="button">Abbrechen</button>
              <button onClick={handleUpdateService} className="primary-btn" type="button" disabled={isMutating}>
                {isMutating ? 'Speichert...' : 'Aenderungen speichern'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default App;
