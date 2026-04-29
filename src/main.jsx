import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

// Polyfill: window.storage falls back to localStorage when not in Claude.ai
if (!window.storage) {
  window.storage = {
    async get(key) {
      const value = localStorage.getItem(key)
      return value ? { key, value } : null
    },
    async set(key, value) {
      localStorage.setItem(key, value)
      return { key, value }
    },
    async delete(key) {
      localStorage.removeItem(key)
      return { key, deleted: true }
    },
    async list(prefix = '') {
      const keys = Object.keys(localStorage).filter(k => k.startsWith(prefix))
      return { keys, prefix }
    },
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
