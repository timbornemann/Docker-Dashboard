import React, { useState, useEffect } from 'react';
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

// Use scan host from window location if on same network, or default
const API_BASE = import.meta.env.VITE_API_URL || ''; 

// Sortable Item Component
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
    touchAction: 'none' // Important for pointer events
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} className="card-wrapper">
      {props.children}
    </div>
  );
}

function App() {
  const [data, setData] = useState({ services: [], lastScan: null, scanRange: { start: 3000, end: 3010 } });
  const [loading, setLoading] = useState(false);
  const [scanRange, setScanRange] = useState({ start: 3000, end: 3010 });
  const [editingService, setEditingService] = useState(null);
  
  // New Service State
  const [addingService, setAddingService] = useState(false);
  const [newServiceUrl, setNewServiceUrl] = useState('');

  // Sensors for dnd-kit
  const sensors = useSensors(
    useSensor(PointerSensor, {
        activationConstraint: {
            distance: 8, // Require movement of 8px to start drag, prevents accidental clicks vs drags
        },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  // Load initial data
  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/services`);
      if (res.ok) {
        const json = await res.json();
        setData(json);
        if (json.scanRange && json.scanRange.start) {
             setScanRange({ start: json.scanRange.start, end: json.scanRange.end });
        }
      }
    } catch (err) {
      console.error("Failed to fetch services", err);
    }
  };

  const handleScan = async () => {
    setLoading(true);
    try {
      // Trigger scan
      await fetch(`${API_BASE}/api/scan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
           startPort: scanRange.start, 
           endPort: scanRange.end,
           host: 'host.docker.internal' 
        })
      });
      
      // Poll for updates
      let checks = 0;
      const interval = setInterval(async () => {
         await fetchData();
         checks++;
         if (checks > 5) {
             clearInterval(interval);
             setLoading(false);
         }
      }, 2000);
      
    } catch (err) {
      console.error("Scan failed", err);
      setLoading(false);
    }
  };

  const handleAddService = async () => {
    if (!newServiceUrl) return;
    setLoading(true);
    try {
        const res = await fetch(`${API_BASE}/api/service/add`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: newServiceUrl })
        });

        if (res.ok) {
            setAddingService(false);
            setNewServiceUrl('');
            fetchData();
        } else {
            alert('Failed to add service');
        }
    } catch (err) {
        console.error(err);
        alert('Error adding service');
    } finally {
        setLoading(false);
    }
  };

  const openEditModal = (e, service) => {
    e.preventDefault(); // Prevent link navigation
    e.stopPropagation();
    // Do not allow dragging while editing? No need, modal is overlay.
    setEditingService({ ...service, newTitle: service.title, newIconFile: null });
  };

  const handleUpdateService = async () => {
    if (!editingService) return;

    try {
        const formData = new FormData();
        formData.append('url', editingService.url);
        formData.append('title', editingService.newTitle);
        if (editingService.newIconFile) {
            formData.append('icon', editingService.newIconFile);
        }

        const res = await fetch(`${API_BASE}/api/service/update`, {
            method: 'POST',
            body: formData
        });

        if (res.ok) {
            setEditingService(null);
            fetchData(); // Refresh data
        } else {
            alert('Failed to update service');
        }
    } catch (err) {
        console.error(err);
        alert('Error updating service');
    }
  };

  const handleDragEnd = async (event) => {
    const { active, over } = event;
    
    if (active.id !== over.id) {
        // Optimistic UI update
        const oldIndex = data.services.findIndex(s => s.url === active.id);
        const newIndex = data.services.findIndex(s => s.url === over.id);
        
        const newOrder = arrayMove(data.services, oldIndex, newIndex);
        
        setData(prev => ({ ...prev, services: newOrder }));
        
        // Persist to backend
        try {
            await fetch(`${API_BASE}/api/services/reorder`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ services: newOrder })
            });
        } catch (err) {
            console.error("Failed to save order", err);
            // Revert? simpler to just refresh or let user know
        }
    }
  };

  return (
    <>
      <header>
        <h1>Docker Dashboard</h1>
        <div className="controls">
          <button className="primary-btn" onClick={() => setAddingService(true)} style={{marginRight: '1rem', background: 'transparent', border: '1px solid var(--accent-color)', color: 'var(--accent-color)'}}>
            + Add Service
          </button>
          <div className="input-group">
            <label>Ports</label>
            <input 
              type="number" 
              value={scanRange.start} 
              onChange={e => setScanRange({...scanRange, start: e.target.value})}
            />
            <span style={{color: 'var(--text-secondary)'}}>-</span>
            <input 
              type="number" 
              value={scanRange.end} 
              onChange={e => setScanRange({...scanRange, end: e.target.value})}
            />
          </div>
          <button className="primary-btn" onClick={handleScan} disabled={loading}>
            {loading ? <div className="loading-spinner"/> : 'Scan Network'}
          </button>
        </div>
      </header>

      <main>
        <DndContext 
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
        >
        {data.services.length === 0 ? (
           <div className="empty-state">
             <h2>No Services Found</h2>
             <p>Enter a port range and click Scan, or add a service manually.</p>
           </div>
        ) : (
           <SortableContext 
                items={data.services.map(s => s.url)}
                strategy={rectSortingStrategy}
           >
           <div className="grid">
             {data.services.map((service, idx) => (
               <SortableItem key={service.url} id={service.url}>
                 <a 
                   href={service.url.replace('host.docker.internal', window.location.hostname)} 
                   target="_blank" 
                   rel="noopener noreferrer" 
                   className="card"
                   // Prevent drag on interactables if necessary, but Dnd-kit with activationConstraint usually handles better
                 >
                   <div className="card-icon">
                      {service.icon ? (
                        <img 
                            src={service.icon.startsWith('/') ? `${API_BASE}${service.icon}` : service.icon} 
                            alt="icon" 
                            onError={(e) => {e.target.style.display='none'; e.target.parentElement.innerText='Web'}} 
                        />
                      ) : 'Web'}
                   </div>
                   <div className="card-title">{service.title || 'Unknown Service'}</div>
                   <div className="card-port">:{service.port}</div>
                 </a>
                 <button className="edit-btn" onClick={(e) => openEditModal(e, service)} onPointerDown={(e) => e.stopPropagation()}>
                    ✎
                 </button>
               </SortableItem>
             ))}
           </div>
           </SortableContext>
        )}
        </DndContext>
      </main>

      {/* Add Service Modal */}
      {addingService && (
        <div className="modal-overlay">
            <div className="modal">
                <h2>Add New Service</h2>
                <div className="form-group">
                    <label>Service URL</label>
                    <input 
                        type="text" 
                        placeholder="http://localhost:8080 or http://google.com"
                        value={newServiceUrl} 
                        onChange={e => setNewServiceUrl(e.target.value)}
                    />
                    <p style={{fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.5rem'}}>
                        We will automatically try to fetch the title and icon.
                    </p>
                </div>
                <div className="modal-actions">
                    <button onClick={() => setAddingService(false)} className="cancel-btn">Cancel</button>
                    <button onClick={handleAddService} className="primary-btn" disabled={loading}>
                        {loading ? 'Adding...' : 'Add Service'}
                    </button>
                </div>
            </div>
        </div>
      )}

      {/* Edit Service Modal */}
      {editingService && (
        <div className="modal-overlay">
            <div className="modal">
                <h2>Edit Service</h2>
                <div className="form-group">
                    <label>Title</label>
                    <input 
                        type="text" 
                        value={editingService.newTitle} 
                        onChange={e => setEditingService({...editingService, newTitle: e.target.value})}
                    />
                </div>
                <div className="form-group">
                    <label>Upload Icon</label>
                    <input 
                        type="file" 
                        accept="image/*"
                        onChange={e => setEditingService({...editingService, newIconFile: e.target.files[0]})}
                    />
                </div>
                <div className="modal-actions">
                    <button onClick={() => setEditingService(null)} className="cancel-btn">Cancel</button>
                    <button onClick={handleUpdateService} className="primary-btn">Save</button>
                </div>
            </div>
        </div>
      )}
    </>
  );
}

export default App;
