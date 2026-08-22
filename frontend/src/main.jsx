import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// App is dark-mode only — apply it once, globally, before anything renders.
document.documentElement.classList.add('dark')

// Note: not using React.StrictMode here. In dev, StrictMode intentionally
// mounts every component twice to surface bugs — but Ballpit's cleanup calls
// renderer.forceContextLoss(), which permanently kills that canvas's WebGL
// context. The second mount then fails to get a new context and crashes.
ReactDOM.createRoot(document.getElementById('root')).render(
  <App />,
)
