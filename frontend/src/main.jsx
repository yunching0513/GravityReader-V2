import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// Ask the browser to keep this app's storage (the PDFs and notes live in
// IndexedDB). On an iPad, Safari may otherwise clear a site's data after a
// stretch without use. Harmless where it's unsupported or refused.
if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {})
}

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>,
)
