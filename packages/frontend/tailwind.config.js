/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          bg: '#262626',
          cyan: '#12ceec',
          purple: '#9c51ff',
        },
        poker: {
          green: '#0E6F3C',
          felt: '#1A5632',
          dark: '#0A1F1A',
          gold: '#FFD700',
          red: '#DC2626',
        },
      },
    },
  },
  plugins: [],
}
