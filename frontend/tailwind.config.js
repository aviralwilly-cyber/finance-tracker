/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{js,jsx}'
  ],
  theme: {
    extend: {
      colors: {
        mint: '#64ffda',
        navy: '#112240',
        slate: '#8892b0'
      }
    }
  },
  plugins: []
}
